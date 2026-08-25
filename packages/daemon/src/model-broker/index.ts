/**
 * Container model access: the one import the rest of the daemon needs.
 *
 * `DaemonModelAccess` is the whole public surface for wiring, and it is what
 * `daemon.ts` constructs and hands to the provisioner. `ModelBroker` and
 * `OmpAuthServices` are exported alongside it because they are the injectable
 * seams its tests replace, and because `ompd doctor` reads their status.
 *
 * `cidr.ts` is deliberately absent. Its address arithmetic exists to serve the
 * broker's peer check and nothing else, and exporting it here would make a
 * private detail of one refusal look like a utility worth reaching for.
 */

export * from "./broker.ts";
export * from "./model-access.ts";
export * from "./omp-auth-services.ts";
