"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible";
import { cn } from "cn";
import { ChevronDownIcon, type LucideIcon, SearchIcon } from "lucide-react";
import type { ComponentProps } from "react";

export type TaskItemFileProps = ComponentProps<"div">;

export const TaskItemFile = ({ children, className, ...props }: TaskItemFileProps) => (
  <div className={cn("inline-flex items-center gap-1 rounded-md border bg-secondary px-1.5 py-0.5 text-foreground text-meta", className)} {...props}>
    {children}
  </div>
);

export type TaskItemProps = ComponentProps<"div">;

export const TaskItem = ({ children, className, ...props }: TaskItemProps) => (
  <div className={cn("text-muted-foreground text-body", className)} {...props}>
    {children}
  </div>
);

export type TaskProps = ComponentProps<typeof Collapsible>;

export const Task = ({ defaultOpen = true, className, ...props }: TaskProps) => <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />;

// loki: the mark is the caller's (a sub-agent's, a background task's), as ChainOfThoughtHeader takes one.
export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
  icon?: LucideIcon;
};

export const TaskTrigger = ({ children, className, title, icon: Icon = SearchIcon, ...props }: TaskTriggerProps) => (
  <CollapsibleTrigger className={cn("group", className)} {...props}>
    {children ?? (
      <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-body hover:text-foreground">
        <Icon className="size-4" />
        <p className="text-body">{title}</p>
        <ChevronDownIcon className="size-4 transition-transform group-data-[panel-open]:rotate-180" />
      </div>
    )}
  </CollapsibleTrigger>
);

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;

export const TaskContent = ({ children, className, ...props }: TaskContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  >
    <div className="mt-4 space-y-2 border-muted border-l-2 pl-4">{children}</div>
  </CollapsibleContent>
);
