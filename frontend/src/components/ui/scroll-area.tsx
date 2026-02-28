import * as React from "react"

const ScrollArea = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ className, children, ...props }, ref) => (
        <div ref={ref} className={`relative overflow-auto custom-scrollbar ${className || ""}`} {...props}>
            {children}
        </div>
    )
)
ScrollArea.displayName = "ScrollArea"

export { ScrollArea }
