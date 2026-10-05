import type { AgentConfig } from '../../src/types/models.ts';

export const prexConfig: AgentConfig = {
  id: 'prex-uy',
  name: 'Prex Uruguay',
  type: 'credit',
  country: 'UY',
  currency: 'UYU',
  initialUrl: 'https://www.prex.com.uy',
  parser: 'pdf',
  steps: [
    {
      id: 'navigate-to-app',
      instruction: 'Navigate to https://www.prex.com.uy. Look for "App Prex", "Banca Online", "Acceder", or "Mi Cuenta" to reach the online banking portal. If cookies already logged you in, proceed to the dashboard.',
    },
    {
      id: 'find-card-statement',
      instruction: 'On the dashboard, look for your Prex card(s). Look for "Estado de Cuenta", "Resumen de Tarjeta", "Movimientos", or "Historial". Click on the card you want statements for.',
    },
    {
      id: 'select-period',
      instruction: 'Look for a period selector. Prex typically uses billing cycles ("período de facturación"). Look for options like "Último período", "Seleccionar período", or calendar controls. Select the most recent billing period or the past 90 days.',
    },
    {
      id: 'download-statement',
      instruction: 'Look for "Descargar Estado de Cuenta", "Exportar", "Ver PDF", or "Enviar por Email". Click the appropriate option. If it emails the statement, note the email confirmation.',
    },
  ],
  completionCriteria: [
    'Estado de cuenta descargado',
    'PDF generado',
    'Export exitoso',
    'Resumen disponible',
  ],
};
