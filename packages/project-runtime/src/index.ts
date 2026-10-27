export { initializeProject } from "./project/initialization";
export { currentNativePlatform, parseNativePlatform } from "./native/platform";
export type { NativePlatform } from "./native/platform.types";
export { nativeExecutableName } from "./native/executable/select";
export { nativeProcessTreeCapability } from "./native/process-lifetime/select";
export type { ProcessTreeCapability } from "./native/process-lifetime/lifetime.types";
export { replaceLocalFile } from "./local-files/replace";
export { restoreProject } from "./project/restoration";
export { openProject, resolveProject } from "./project/selection";
export {
  initializeWorkspace,
  listProjects,
  registerProject,
  unregisterProject,
} from "./workspace/registry";
export type { OpenedProject, ProjectLocation } from "./project/location.types";
export type { RuntimeOptions } from "./configuration/runtime-options.types";
export { createGitSyncClient, decodeGitSyncResponse } from "./git-sync/client";
export { assertGitSyncJson, encodeGitSyncRequest } from "./git-sync/request";
export { isGitSyncWorkspace, readGitSyncWorkspaceStatus } from "./git-sync/status";
export type { GitSyncClient, GitSyncEnvironment } from "./git-sync/client.types";
export type { GitSyncServiceAction, GitSyncServiceStatus } from "./git-sync/service.types";
export type { GitSyncWorkspaceStatus } from "./git-sync/status.types";
export { runNativeProcess } from "./git-sync/process";
export { discoverGitSyncBinary } from "./git-sync/discovery";
export type { ProcessCommand, ProcessResult, ProcessRunner } from "./git-sync/process.types";
export {
  gitSyncControlRelease,
  readGitSyncControlEndpoint,
  probeGitSyncSupervisor,
  probeGitSyncSupervisorLock,
  waitForGitSyncSupervisor,
} from "./git-sync/supervisor";
export type {
  GitSyncControlEndpoint,
  GitSyncSupervisorStatus,
  SupervisorProbeOptions,
} from "./git-sync/supervisor.types";
export { createServiceConfiguration } from "./git-sync/service-configuration";
export { createNativeProcessRunner } from "./git-sync/process";
export { sourceGuardianComponent } from "./process-guardian/component";
export { buildSourceGuardianComponent } from "./process-guardian/component-build";
export { runGuardedCommand } from "./process-guardian/runner";
export { runGuardianEntry } from "./process-guardian/entry";
export { GuardedCommandError } from "./process-guardian/errors";
export { combineProcessFailures } from "./process-guardian/component-failures";
export type {
  GuardedCommandOptions,
  GuardedCommandResult,
  GuardedCommandFailureReason,
  GuardedCommandFailureDetails,
  GuardedCommandDiagnostic,
  GuardedCommandFailureStage,
  GuardedCommandSystemCode,
} from "./process-guardian/guardian.types";
export { resumeProjectRestoration } from "./project/restoration-resume";
export type {
  RestorationResumeResult,
  RestorationResumeRecovery,
} from "./project/restoration-resume.types";
export { createServerClient } from "./server/client";
export { discoverServerBinary } from "./server/discovery";
export { createServerLaunch, readServerLaunch } from "./server/registry";
export { resolveServerScope } from "./server/scope";
export { acquireServerInstance } from "./server/registration";
export { listServerInstances, probeServerInstance } from "./server/probe";
export { createServerServiceConfiguration } from "./server/service-configuration";
export type { ServerServiceInput } from "./server/service.types";
export type {
  ServerClient,
  ServerEnvironment,
  ServerLaunch,
  ServerLaunchInput,
  ServerStartInput,
  ServerProjectLocation,
  ResolvedServerScope,
  ServerReadyInput,
  ServerRegistration,
} from "./server/server.types";
