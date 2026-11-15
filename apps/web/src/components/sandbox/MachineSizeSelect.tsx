import type { CloudMachineSize, SandboxSize } from "@t3tools/contracts";
import { machineSpecLabel, SANDBOX_SIZE_LABELS } from "@t3tools/shared/sandbox";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** A cloud machine's size, as the fork and Continue in cloud dialogs ask for it. */
export function MachineSizeSelect({
  id,
  sizes,
  value,
  onChange,
  disabled = false,
}: {
  readonly id: string;
  readonly sizes: ReadonlyArray<CloudMachineSize>;
  readonly value: SandboxSize;
  readonly onChange: (spec: CloudMachineSize) => void;
  readonly disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const spec = sizes.find((candidate) => candidate.size === next);
        if (spec) onChange(spec);
      }}
    >
      <SelectTrigger id={id}>
        <SelectValue>{SANDBOX_SIZE_LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {sizes.map((spec) => (
          <SelectItem key={spec.size} value={spec.size}>
            <span className="flex min-w-0 items-center gap-1.5">
              <span>{SANDBOX_SIZE_LABELS[spec.size]}</span>
              <span className="text-muted-foreground">{machineSpecLabel(spec)}</span>
              {spec.default ? (
                <span className="ms-auto ps-2 text-muted-foreground text-xs">team default</span>
              ) : null}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
