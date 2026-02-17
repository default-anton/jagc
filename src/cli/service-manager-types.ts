export const supportedLogLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type ServiceLogLevel = (typeof supportedLogLevels)[number];
export type ServiceRunner = 'pi' | 'echo';
