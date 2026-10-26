export function parseInput(raw: string): {
  command: string;
  log: string;
  changeSummary?: string;
};

export function dryRunResult(): {
  category: "unknown";
  evidenceSufficient: false;
  requiresReview: true;
  reviewReason: "dry_run_requires_explicit_live_flag";
};
