import type { AgentConfig } from '../../src/types/models';

export const itauConfig: AgentConfig = {
  id: 'itau-uy',
  name: 'Itau Uruguay',
  type: 'bank',
  country: 'UY',
  currency: 'UYU',
  initialUrl: 'https://www.itau.com.uy',
  parser: 'pdf',
  steps: [
    {
      id: 'navigate-to-portal',
      instruction: 'Navigate to https://www.itau.com.uy and then look for "Banca por Internet" or "Acceder" to reach the login page. If cookies already logged you in, you should see the dashboard. From the dashboard, look for "Estado de Cuenta", "Consultas", "Operaciones", or "Servicios" in the menu.',
    },
    {
      id: 'select-account',
      instruction: 'If you see multiple accounts, select the primary checking account ("Cuenta Corriente"). Look for a dropdown or account selector. Click on the account you want to download statements for.',
    },
    {
      id: 'find-estado-cuenta',
      instruction: 'Look for "Estado de Cuenta", "Movimientos", "Historial de Operaciones", or "Descargar Estado de Cuenta". This may be under a "Consultas" or "Servicios" submenu. Click on it.',
    },
    {
      id: 'select-date-range',
      instruction: 'Select the date range for the statement. Look for "Desde" (from) and "Hasta" (to) date fields. Set to the past 90 days. Look for date format DD/MM/YYYY. Click "Buscar" or "Consultar" after setting dates.',
    },
    {
      id: 'download-statement',
      instruction: 'Look for a "Descargar", "Exportar", "Generar PDF", or "Imprimir" button. Click it to download the statement. If it opens a preview, look for a download or print icon.',
    },
  ],
  completionCriteria: [
    'Estado de cuenta',
    'Descarga exitosa',
    'PDF generado',
    'Exportado correctamente',
  ],
  fallbacks: [
    {
      trigger: 'Cannot find Estado de Cuenta',
      instruction: 'Try looking for "Banca Personal" > "Cuentas" > "Estado de Cuenta". Or look for "Contacto" and check if there is an option to request statements by email.',
    },
  ],
};
