import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils.ts";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				default: "bg-(--color-primary) text-(--color-primary-foreground) hover:opacity-90",
				destructive:
					"bg-(--color-destructive) text-(--color-destructive-foreground) hover:opacity-90",
				outline:
					"border bg-(--color-card) text-(--color-fg) hover:bg-(--color-accent) hover:text-(--color-fg)",
				ghost: "text-(--color-fg) hover:bg-(--color-accent)",
				link: "text-(--color-fg) underline-offset-4 hover:underline",
			},
			size: {
				default: "h-9 px-4 py-2",
				sm: "h-8 rounded-md px-3 text-xs",
				lg: "h-10 rounded-md px-6",
				icon: "h-9 w-9",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, asChild = false, ...props }, ref) => {
		const Comp = asChild ? Slot : "button";
		return (
			<Comp
				ref={ref}
				className={cn(buttonVariants({ variant, size, className }))}
				{...props}
			/>
		);
	},
);
Button.displayName = "Button";

export { buttonVariants };
