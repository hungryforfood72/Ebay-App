import type { BadgeTone } from "@/components/ui/Badge";
import type { DudBoxStatus } from "@/lib/warehouse/dudBoxTypes";

// Shared by the dud box list and the box page.

export const STATUS_TEXT: Record<DudBoxStatus, string> = {
  open: "Being filled",
  closed: "Ready to process",
  done: "Done",
};

export const STATUS_TONE: Record<DudBoxStatus, BadgeTone> = { open: "neutral", closed: "warning", done: "success" };
