import { CliRenderEvents, resolveRenderLib, type CliRenderer } from "@opentui/core"
import { Effect, Scope, Stream } from "effect"
import { projectDisplayedStatus } from "../../application/displayed-status"
import type { ApplicationViewModel } from "../../application/view-model"
import { makeProgramStatusReporter, type ProgramStatusReporterApi } from "../../services/program-status"

export function makeOpenTuiProgramStatusReporter(
  renderer: CliRenderer,
): Effect.Effect<ProgramStatusReporterApi, never, Scope.Scope> {
  return Effect.acquireRelease(Effect.sync(() => {
    if (renderer.isDestroyed) return { report() {}, shutdown() {} }
    const lib = resolveRenderLib()
    const reporter = makeProgramStatusReporter((sequence) => lib.writeOut(renderer.rendererPtr, sequence))
    // DESTROY runs before native renderer disposal, even though isDestroyed is already true.
    const shutdown = () => {
      reporter.shutdown()
      renderer.off(CliRenderEvents.DESTROY, shutdown)
    }
    renderer.on(CliRenderEvents.DESTROY, shutdown)
    return { report: reporter.report, shutdown }
  }), (reporter) => Effect.sync(reporter.shutdown))
}

export function reportApplicationToProgramStatus(
  reporter: ProgramStatusReporterApi,
  viewModels: Stream.Stream<ApplicationViewModel>,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.forkScoped(Stream.runForEach(viewModels, (viewModel) => Effect.sync(() => {
    if (viewModel.shuttingDown) reporter.shutdown()
    else reporter.report(projectDisplayedStatus(viewModel).activity)
  }))).pipe(Effect.asVoid)
}
