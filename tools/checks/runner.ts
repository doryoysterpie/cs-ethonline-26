/**
 * The one runner every CI job runs on (D56). The label pins the operating
 * system's release, not the image: GitHub refreshes the image under the same
 * label on its own schedule, and hosted runners offer no way to pin an image
 * build, so a weekly refresh still arrives unreviewed and is identified by the
 * `ImageOS` and `ImageVersion` each job logs first. A change of release is a
 * reviewed pull request: this constant, every `runs-on` in `.github/workflows`
 * (held to it by `tools/checks/workflows.ts`) and the bill of materials
 * (`tools/supply-chain/sbom.ts` records it as a component) change together.
 * GitHub retires an old label, with brownouts first; the bill of materials is
 * where that bump is planned.
 */
export const RUNNER_LABEL = 'ubuntu-26.04';

/** The name of the first step of every job, which logs the runner image. */
export const RUNNER_IMAGE_STEP = 'Runner image';
