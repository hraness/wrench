import { runCli as runCliImplementation } from "./cli";
export {
  renderDoctorReport,
  runDoctor,
} from "./doctor";

// Keep a concrete binding so the Wrench runtime can lazy-load one stable media
// module without depending on a separate package or executable boundary.
export const runCli: typeof runCliImplementation = (argv, options) =>
  runCliImplementation(argv, options);
