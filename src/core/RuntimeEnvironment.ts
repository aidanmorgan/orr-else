export interface RuntimeEnvironment {
  env(name: string): string | undefined;
}

export const nodeRuntimeEnvironment: RuntimeEnvironment = {
  env: (name: string): string | undefined => process.env[name]
};
