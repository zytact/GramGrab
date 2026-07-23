export interface IpcEnvironment {
  readonly platform: string;
  readonly runtimeDirectory?: string;
  readonly userId?: number;
  readonly override?: string;
}

export function localIpcEndpoint(environment: IpcEnvironment): string {
  if (environment.override) return environment.override;
  if (environment.platform === 'win32') return String.raw`\\.\pipe\gramgrab`;
  const directory = environment.runtimeDirectory ?? '/tmp';
  const suffix = environment.userId === undefined ? '' : `-${environment.userId}`;
  return `${directory}/gramgrab${suffix}.sock`;
}
