import puppeteer from 'puppeteer';
import type {
  AgentConfig,
  LlmDecision,
  IngestionRun,
  IngestionStep,
  Institution,
  Account,
  Transaction,
} from '../../src/types/models';
import { DatabaseQueries } from '../db/queries';
import { generateId, now } from '../../src/types/models';
import * as fs from 'fs';
import * as path from 'path';

const SEVILLE_DIR = path.join(process.env.HOME || '', '.seville');
const COOKIES_DIR = path.join(SEVILLE_DIR, 'cookies');
const SCREENSHOTS_DIR = path.join(SEVILLE_DIR, 'screenshots');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama-3.2';
const MAX_ITERATIONS = 50;
const MAX_AGE_MINUTES = 10;

// ─── Browser Manager ───

class BrowserManager {
  private browser: puppeteer.Browser | null = null;
  private pages: Map<string, puppeteer.Page> = new Map();

  async launch(): Promise<puppeteer.Browser> {
    if (this.browser) {
      return this.browser;
    }

    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    return this.browser;
  }

  async getPage(institutionId: string): Promise<puppeteer.Page> {
    if (this.pages.has(institutionId)) {
      return this.pages.get(institutionId)!;
    }

    if (!this.browser) {
      await this.launch();
    }

    const page = await this.browser.createPage();
    this.pages.set(institutionId, page);
    return page;
  }

  async closePage(institutionId: string): Promise<void> {
    const page = this.pages.get(institutionId);
    if (page) {
      await page.close().catch(() => {});
      this.pages.delete(institutionId);
    }
  }

  async close(): Promise<void> {
    for (const [id, page] of this.pages) {
      await page.close().catch(() => {});
      this.pages.delete(id);
    }

    await this.browser?.close().catch(() => {});
    this.browser = null;
  }
}

// ─── Session Manager ───

class SessionManager {
  private cookiesDir: string;

  constructor(cookiesDir: string) {
    this.cookiesDir = cookiesDir;
    fs.mkdirSync(this.cookiesDir, { recursive: true });
  }

  async exportCookies(page: puppeteer.Page, institutionId: string): Promise<void> {
    const cookies = await page.cookies();
    const filePath = path.join(this.cookiesDir, `${institutionId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(cookies, null, 2));
  }

  async loadCookies(page: puppeteer.Page, institutionId: string): Promise<boolean> {
    const filePath = path.join(this.cookiesDir, `${institutionId}.json`);

    if (!fs.existsSync(filePath)) {
      return false;
    }

    const cookies = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Array<Record<string, unknown>>;

    if (cookies.length === 0) {
      return false;
    }

    const typedCookies = cookies.map((c) => ({
      name: String(c.name || c['name'] || ''),
      value: String(c.value || c['value'] || ''),
      domain: String(c.domain || c['domain'] || ''),
      path: String(c.path || c['path'] || '/'),
      secure: Boolean(c.secure || c['secure']),
      httpOnly: Boolean(c.httpOnly || c['httpOnly']),
      sameSite: (c.sameSite || c['sameSite']) as 'Strict' | 'Lax' | 'None' | undefined,
      expires: typeof c.expires === 'number' ? c.expires : undefined,
    }));

    await page.setCookie(...typedCookies);
    return true;
  }

  hasSession(institutionId: string): boolean {
    const filePath = path.join(this.cookiesDir, `${institutionId}.json`);
    return fs.existsSync(filePath);
  }

  clearSession(institutionId: string): void {
    const filePath = path.join(this.cookiesDir, `${institutionId}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore if file doesn't exist
    }
  }
}

// ─── Screenshot Capture ───

class ScreenshotCapture {
  private screenshotsDir: string;

  constructor(screenshotsDir: string) {
    this.screenshotsDir = screenshotsDir;
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
  }

  async capture(page: puppeteer.Page, stepNumber: number): Promise<string> {
    const institutionId = await page.url()
      .then((url) => {
        try {
          return new URL(url).hostname.split('.')[0] || 'unknown';
        } catch {
          return 'unknown';
        }
      })
      .catch(() => 'unknown');

    const fileName = `${institutionId}_${stepNumber}.png`;
    const filePath = path.join(this.screenshotsDir, fileName);

    await page.screenshot({ path: filePath, fullPage: false });

    return filePath;
  }
}

// ─── LLM Router ───

class LlmRouter {
  private ollamaUrl: string;
  private model: string;

  constructor(ollamaUrl: string, model: string) {
    this.ollamaUrl = ollamaUrl;
    this.model = model;
  }

  async decide(page: puppeteer.Page, context: {
    institutionId: string;
    config: AgentConfig;
    iteration: number;
    previousSteps: IngestionStep[];
  }): Promise<LlmDecision> {
    const url = await page.url().catch(() => 'unknown');
    const prompt = this.buildPrompt(page, context);

    let imageBase64: string;
    try {
      const screenshotPath = await new ScreenshotCapture(SCREENSHOTS_DIR).capture(page, context.iteration);
      const screenshotBuffer = fs.readFileSync(screenshotPath);
      imageBase64 = screenshotBuffer.toString('base64');
    } catch {
      imageBase64 = '';
    }

    try {
      return await this.callOllama(imageBase64, prompt);
    } catch (error) {
      console.error(`[LlmRouter] Ollama call failed:`, error);
      return this.getFallbackDecision(context);
    }
  }

  private buildPrompt(page: puppeteer.Page, context: {
    institutionId: string;
    config: AgentConfig;
    iteration: number;
    previousSteps: IngestionStep[];
  }): string {
    const url = page.url().catch(() => 'unknown');

    const stepsDescription = context.config.steps
      .map((s) => `  - [${s.id}] ${s.instruction}`)
      .join('\n');

    const stepsTaken = context.previousSteps
      .map((s) => `  Step ${s.order}: ${s.action} → ${s.result} (${s.message || 'no message'})`)
      .join('\n') || '  (none)';

    return `You are a banking assistant agent for the Seville finance system. Your goal is to download bank/investment statements for institution "${context.institutionId}".

You are currently on URL: ${url}
Iteration: ${context.iteration} / ${MAX_ITERATIONS}
Maximum age limit: ${MAX_AGE_MINUTES} minutes

Available steps for this institution:
${stepsDescription}

Previous steps taken:
${stepsTaken}

What do you see on screen? What should be done next?

Rules:
- If you see a login page, click the login button or fill in credentials
- If you see a dashboard, look for "transactions", "downloads", "statements", or "export" buttons
- If you see a transaction list, extract the data and mark as done
- If you see an error, report it
- If you need to wait for content, use the wait action

Respond ONLY as valid JSON with no markdown formatting, no backticks, no explanation:
{
  "action": "navigate" | "click" | "extract" | "done" | "wait",
  "target": "description of what to interact with (URL for navigate, button text for click)",
  "targetText": "what is visible on screen",
  "data": {} // optional: extracted transaction data
}

Do NOT wrap in code blocks. Return raw JSON only.`;
  }

  private async callOllama(imageBase64: string, prompt: string): Promise<LlmDecision> {
    const response = await fetch(`${this.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: prompt,
            images: imageBase64 ? [imageBase64] : undefined,
          },
        ],
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const rawContent = data.message?.content || '';

    return this.parseLlmDecision(rawContent);
  }

  private parseLlmDecision(rawContent: string): LlmDecision {
    const cleaned = rawContent
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}') + 1;

    if (jsonStart === -1 || jsonEnd === 0) {
      throw new Error('No JSON found in LLM response');
    }

    const jsonStr = cleaned.substring(jsonStart, jsonEnd);
    const parsed = JSON.parse(jsonStr) as Partial<LlmDecision>;

    const action = parsed.action || 'wait';
    const validActions = ['navigate', 'click', 'extract', 'done', 'wait'];
    if (!validActions.includes(action)) {
      throw new Error(`Invalid action: ${action}`);
    }

    return {
      action,
      target: parsed.target || '',
      targetText: parsed.targetText || '',
      data: parsed.data,
    };
  }

  private getFallbackDecision(context: {
    institutionId: string;
    config: AgentConfig;
    iteration: number;
    previousSteps: IngestionStep[];
  }): LlmDecision {
    const firstStep = context.config.steps[0];

    if (context.iteration === 0 && firstStep) {
      return {
        action: 'navigate',
        target: context.config.initialUrl,
        targetText: 'Initial page load',
      };
    }

    const lastStep = context.previousSteps[context.previousSteps.length - 1];
    if (lastStep?.result === 'failed') {
      return {
        action: 'wait',
        target: 'current page',
        targetText: 'Previous step failed, waiting for recovery',
      };
    }

    return {
      action: 'done',
      target: '',
      targetText: 'Fallback: no LLM response available',
    };
  }
}

// ─── Action Executor ───

class ActionExecutor {
  async execute(decision: LlmDecision, page: puppeteer.Page): Promise<{ success: boolean; message?: string }> {
    switch (decision.action) {
      case 'navigate': {
        const url = decision.target.startsWith('http')
          ? decision.target
          : `https://${decision.target}`;

        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        return { success: true };
      }

      case 'click': {
        await this.clickByText(page, decision.target);
        return { success: true };
      }

      case 'extract': {
        const data = await this.extractPageData(page);
        return { success: true, message: 'Data extraction step' };
      }

      case 'done': {
        return { success: true };
      }

      case 'wait': {
        await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
        return { success: true };
      }

      default: {
        return { success: false, message: `Unknown action: ${decision.action}` };
      }
    }
  }

  private async clickByText(page: puppeteer.Page, text: string): Promise<void> {
    const result = await page.evaluate((searchText) => {
      const allElements = document.querySelectorAll('*');
      const elements: { selector: string; tag: string; text: string }[] = [];

      for (const el of Array.from(allElements)) {
        const tag = el.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'link', 'meta', 'head'].includes(tag)) {
          continue;
        }

        const clickableTags = ['button', 'a', 'input', 'option', 'summary', 'label', '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]', '[role="option"]', '[role="checkbox"]'];
        const isClickable = clickableTags.some((t) => {
          if (t.includes('[')) {
            return el.hasAttribute(t.split('[')[0].replace('[', '').replace(']', '')) &&
              el.getAttribute('role')?.includes(t.split('["')[1]?.split('"')[0] || '');
          }
          return tag === t;
        });

        if (!isClickable) continue;

        const textContent = el.textContent?.trim();
        if (!textContent) continue;

        const normalizedSearch = searchText.toLowerCase().trim();
        const normalizedText = textContent.toLowerCase();

        if (normalizedText.includes(normalizedSearch) || normalizedSearch.includes(normalizedText)) {
          const selector = this.generateSelector(el);
          elements.push({ selector, tag, text: textContent });
        }
      }

      return elements;
    }, text);

    if (result.length === 0) {
      throw new Error(`No clickable element found matching text: "${text}"`);
    }

    const target = result[0].selector;
    await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (el) {
        (el as HTMLElement).click();
      }
    }, target);
  }

  private generateSelector(element: Element): string {
    const parts: string[] = [];
    let current: Element | null = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let selector = current.tagName.toLowerCase();

      if (current.id) {
        return `[id="${current.id}"]`;
      }

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (s) => s.tagName === current.tagName,
        );

        if (siblings.length > 1) {
          const index = siblings.indexOf(current as HTMLElement) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }

      parts.unshift(selector);
      current = current.parentElement;

      if (parts.length > 5) break;
    }

    return parts.join(' > ');
  }

  private async extractPageData(page: puppeteer.Page): Promise<Record<string, any>> {
    const data = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const tables = Array.from(document.querySelectorAll('table'));
      const tableData = tables.map((table) => {
        const rows = Array.from(table.querySelectorAll('tr'));
        return rows.map((row) => {
          const cells = Array.from(row.querySelectorAll('td, th'));
          return cells.map((cell) => cell.textContent?.trim() || '');
        });
      });

      const links = Array.from(document.querySelectorAll('a'))
        .map((a) => ({ text: a.textContent?.trim(), href: a.getAttribute('href') }))
        .filter((l) => l.text);

      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
        .map((b) => b.textContent?.trim())
        .filter(Boolean);

      return {
        bodyText: bodyText.substring(0, 5000),
        tables: tableData,
        links: links.slice(0, 50),
        buttons: buttons.slice(0, 30),
      };
    });

    return data;
  }
}

// ─── Agent Orchestrator (MAIN) ───

export class AgentOrchestrator {
  private browserManager: BrowserManager;
  private sessionManager: SessionManager;
  private screenshotCapture: ScreenshotCapture;
  private llmRouter: LlmRouter;
  private actionExecutor: ActionExecutor;
  private db: DatabaseQueries;

  constructor(db: DatabaseQueries) {
    this.db = db;
    this.browserManager = new BrowserManager();
    this.sessionManager = new SessionManager(COOKIES_DIR);
    this.screenshotCapture = new ScreenshotCapture(SCREENSHOTS_DIR);
    this.llmRouter = new LlmRouter(OLLAMA_URL, OLLAMA_MODEL);
    this.actionExecutor = new ActionExecutor();
  }

  async run(config: AgentConfig, dateRange: { from: Date; to: Date }): Promise<IngestionRun> {
    const runId = generateId();
    const startedAt = now();

    const run: Omit<IngestionRun, 'completedAt' | 'steps'> = {
      id: runId,
      institutionId: config.id,
      startedAt,
      status: 'running',
      transactionsIngested: 0,
    };

    this.db.createIngestionRun(run);
    this.db.updateInstitutionStatus(config.id, 'active');

    let page: puppeteer.Page | null = null;
    const steps: IngestionStep[] = [];

    try {
      await this.browserManager.launch();
      page = await this.browserManager.getPage(config.id);

      if (this.sessionManager.hasSession(config.id)) {
        await this.sessionManager.loadCookies(page, config.id);
      }

      let iteration = 0;
      let hasTransactions = false;

      while (iteration < MAX_ITERATIONS) {
        const stepNumber = iteration + 1;

        try {
          const decision = await this.llmRouter.decide(page, {
            institutionId: config.id,
            config,
            iteration,
            previousSteps: steps,
          });

          const screenshotPath = await this.screenshotCapture.capture(page, stepNumber);

          const step: Omit<IngestionStep, 'id'> = {
            order: stepNumber,
            action: decision.action,
            result: 'success',
            message: `LLM chose: ${decision.action} → ${decision.target}`,
            screenshotPath,
            llmDecision: JSON.stringify(decision),
          };

          this.db.createIngestionStep(step);
          steps.push(step as IngestionStep);

          const execResult = await this.actionExecutor.execute(decision, page);

          if (!execResult.success) {
            step.result = 'failed';
            step.message = execResult.message;
            this.db.createIngestionStep(step);
            steps[steps.length - 1] = step as IngestionStep;

            if (decision.action === 'done') {
              break;
            }

            iteration++;
            continue;
          }

          if (decision.data && Object.keys(decision.data).length > 0) {
            hasTransactions = true;
          }

          if (decision.action === 'done') {
            break;
          }

          iteration++;
        } catch (error) {
          const errorStep: Omit<IngestionStep, 'id'> = {
            order: stepNumber,
            action: 'error',
            result: 'failed',
            message: error instanceof Error ? error.message : 'Unknown error',
          };

          this.db.createIngestionStep(errorStep);
          steps.push(errorStep as IngestionStep);

          iteration++;

          if (iteration >= MAX_ITERATIONS) {
            break;
          }
        }
      }

      const transactionsIngested = steps.filter(
        (s) => s.llmDecision && JSON.parse(s.llmDecision).data,
      ).reduce((acc, s) => {
        const decision = JSON.parse(s.llmDecision || '{}') as LlmDecision;
        return acc + (decision.data ? Object.keys(decision.data).length : 0);
      }, 0);

      const finalStatus: IngestionRun['status'] = hasTransactions ? 'success' : 'error';
      const finalError = hasTransactions ? undefined : 'No transactions were extracted during the run.';

      this.db.updateIngestionRunStatus(
        runId,
        finalStatus,
        transactionsIngested,
        finalError,
      );

      await this.sessionManager.exportCookies(page, config.id);
      this.db.updateInstitutionLastSync(config.id);

      return this.db.getIngestionRun(runId)!;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during run';
      this.db.updateIngestionRunStatus(runId, 'error', 0, errorMessage);

      await this.closePage(config.id);

      return this.db.getIngestionRun(runId)!;
    } finally {
      await this.closePage(config.id);
    }
  }

  async closePage(institutionId: string): Promise<void> {
    await this.browserManager.closePage(institutionId);
  }

  async exportSession(config: AgentConfig): Promise<void> {
    const browser = await this.browserManager.launch();
    const page = await browser.createPage();

    await page.goto(config.initialUrl, { waitUntil: 'networkidle0', timeout: 30000 });

    console.log(`\n=== Session Export for ${config.name} ===`);
    console.log(`Navigate to: ${config.initialUrl}`);
    console.log('Complete the login process manually...');
    console.log('Press Enter when done to save cookies...\n');

    await new Promise<void>((resolve) => {
      const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      readline.question('', () => {
        readline.close();
        resolve();
      });
    });

    await this.sessionManager.exportCookies(page, config.id);

    await page.close();
    await browser.close();

    console.log(`Session saved to ${path.join(COOKIES_DIR, `${config.id}.json`)}\n`);
  }
}
