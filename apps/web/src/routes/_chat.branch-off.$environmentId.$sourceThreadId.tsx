import { createFileRoute } from "@tanstack/react-router";

import { BranchOffRoutePage } from "../components/branchOff/BranchOffPage";

export const Route = createFileRoute("/_chat/branch-off/$environmentId/$sourceThreadId")({
  component: BranchOffRoutePage,
});
