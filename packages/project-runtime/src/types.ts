export interface RuntimeOptions {
  cwd: string;
  home?: string;
  config?: string;
  project?: string;
}

export interface ProjectLocation {
  projectId: string;
  databasePath: string;
  configPath: string;
}
