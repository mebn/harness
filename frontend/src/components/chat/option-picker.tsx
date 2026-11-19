import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Option } from "@/lib/backend";

type Props = {
  value: string;
  options: Option[];
  onChange: (id: string) => void;
  disabled?: boolean;
};

/** Compact dropdown used for provider / model / effort / mode in the composer. */
export function OptionPicker({ value, options, onChange, disabled }: Props) {
  const current = options.find((o) => o.id === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground disabled:opacity-50 data-[state=open]:bg-accent [&_svg]:size-3.5"
      >
        <span>{current?.label ?? value}</span>
        <ChevronDown className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-36">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.id} value={o.id} className="text-xs">
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
