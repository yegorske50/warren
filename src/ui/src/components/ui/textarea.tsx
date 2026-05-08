import * as React from "react";
import { cn } from "@/lib/utils.ts";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
	({ className, ...props }, ref) => (
		<textarea
			ref={ref}
			className={cn(
				"flex w-full rounded-md border bg-(--color-card) px-3 py-2 text-sm shadow-xs",
				"placeholder:text-(--color-muted-foreground)",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)",
				"disabled:cursor-not-allowed disabled:opacity-50",
				"min-h-20 resize-y",
				className,
			)}
			{...props}
		/>
	),
);
Textarea.displayName = "Textarea";
