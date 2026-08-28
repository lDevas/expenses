import type { AgentConfig } from '../../src/types/models';

export const santanderConfig: AgentConfig = {
  id: 'santander-uy',
  name: 'Banco Santander Uruguay',
  type: 'bank',
  country: 'UY',
  currency: 'UYU',
  initialUrl: 'https://internet.santander.com.uy',
  parser: 'pdf',
  steps: [
    {
      id: 'login-check',
      instruction: 'Navigate to https://internet.santander.com.uy. If you see a login screen, the session cookies should already log you in. If you see the main dashboard with account summaries, proceed to the next step.',
    },
    {
      id: 'find-exports',
      instruction: 'Look for a menu item or link related to exporting statements. Common labels in Spanish: "Exportar", "Descargar Estado de Cuenta", "Operaciones", "Consultas", "Servicios". Look in the left sidebar or top navigation. Click on it.',
    },
    {
      id: 'select-date-range',
      instruction: 'You should now see a form to select a date range. Look for fields labeled "Desde" (from) and "Hasta" (to). Set the date range to cover the past 90 days. If there is a calendar picker, select the appropriate dates. If there is a "Período" dropdown, select "Últimos 90 días" or "Personalizado".',
    },
    {
      id: 'download-statement',
      instruction: 'Look for a button to generate/download the statement. Labels to look for: "Exportar", "Generar", "Descargar", "Enviar por email", "Generar PDF". Click the button. If it says the PDF will be emailed, look for an "Email" option and select your email. If it downloads directly, wait for the download to complete.',
    },
    {
      id: 'confirm-download',
      instruction: 'Check if a confirmation message appears like "Archivo descargado", "Export exitoso", "Estado de cuenta generado", "PDF listo para descargar". If you see the statement PDF starting to download, the process is complete. If you see an error, note what the error says.',
    },
  ],
  completionCriteria: [
    'Archivo descargado',
    'Export exitoso',
    'Estado de cuenta generado',
    'PDF listo',
    'Descarga completada',
    'Download complete',
    'Exitoso',
  ],
};
