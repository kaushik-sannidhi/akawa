"use client";

import Link from "next/link";
import { useEffect, useState, useRef, useCallback } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

if (typeof window !== "undefined") {
    gsap.registerPlugin(ScrollTrigger);
}

// High-end Brutalist text decoder animation
const ScrambleText = ({ text, delay = 0, durationMultiplier = 1, className = "" }: { text: string; delay?: number; durationMultiplier?: number; className?: string }) => {
    const [displayText, setDisplayText] = useState("");
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$*&%";

    useEffect(() => {
        let iteration = 0;
        let animationFrame: number;
        let startTimeout: NodeJS.Timeout;

        const startAnimation = () => {
            const animate = () => {
                setDisplayText(text.split("").map((letter, index) => {
                    if (index < iteration || letter === " ") return text[index];
                    return chars[Math.floor(Math.random() * chars.length)];
                }).join(""));

                if (iteration >= text.length) {
                    cancelAnimationFrame(animationFrame);
                    setDisplayText(text);
                    return;
                }
                iteration += (1 / 3) / durationMultiplier;
                animationFrame = requestAnimationFrame(animate);
            };
            animate();
        };

        startTimeout = setTimeout(startAnimation, delay);

        return () => {
            clearTimeout(startTimeout);
            cancelAnimationFrame(animationFrame);
        };
    }, [text, delay, durationMultiplier]);

    return (
        <span className={`inline-block font-mono ${className}`}>
            {displayText || " "}
        </span>
    );
};

const useInView = (options = {}) => {
    const ref = useRef(null);
    const [isInView, setIsInView] = useState(false);

    useEffect(() => {
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) setIsInView(true);
        }, { threshold: 0.1, ...options });

        if (ref.current) observer.observe(ref.current);
        return () => observer.disconnect();
    }, [options]);

    return [ref, isInView] as const;
};

// Accurate US Contiguous Outline (simplified Albers projection, viewBox 0 0 960 600)
const US_OUTLINE_PATH = "m 173.6,1157 h -1.5 -1.4 l 0.7,-4 h 3.6 z m -10.8,-4 -1.5,4 h -3.6 l 0.8,-4 h 1.4 z m 16.5,0 h -2.1 -0.7 1.4 2.1 z m 8.7,0 h -1.5 -2.1 -3.6 l 2.1,-4 h 4.3 1.5 z m -33.2,4 H 152 l -5.1,-4 h -5 -7.2 l -0.7,-4 h 7.9 2.9 3.6 v 0 l 2.8,4 h 4.4 z m 1501.2,-4 -5,4 1,-8 12,-8 3,4 3,4 h -8 z m -1537.1,-8 5,4 h 2.9 2.9 -0.8 l -2.8,4 h -7.2 l -4.4,-4 h -6.4 v -8 l 4.3,4 z m 114.4,-4 h 0.8 l -1.5,4 h -5.7 l -3.6,-4 -0.8,4 h -0.7 l -2.1,4 h -2.9 l -4.3,4 h -5.1 l -2.9,-4 -2.8,4 h -6.5 l -2.2,4 -2.9,-4 6.5,-4 5.8,-4 h 2.9 l 3.6,4 h 2.8 l 0.8,-4 v -4 h 2.1 2.2 1.4 3.6 1.5 l 0.7,-4 h 2.1 2.9 l 2.2,4 z m -149.01,0 h 0.72 -2.88 l -2.88,-4 1.44,-4 z m 7.2,-8 -0.72,4 -4.32,-4 h 2.16 2.16 z m -18.72,-4 h -3.6 l -1.44,-4 h 3.6 2.16 v 4 z m -28.12,-24 -1.44,4 -2.16,-4 5.04,-4 h 1.44 z m 721.45,8 v 8 h 3.6 l 1.6,4 6.4,4 -10,8 -6,4 -4.8,-4 -8,4 -7.2,16 -8.8,-12 -2,-20 -3.6,-8 8,-8 -2.8,-8 2,-4 28,12 z M 44.65,1097 h -4.32 l -5.02,-4 h 2.16 4.3 z m 300.25,4 -5,4 -2.9,4 -2.1,-4 h -1.5 v 4 l -2.9,4 v 0 l -2.8,4 -2.9,-4 2.1,-4 -2.8,-8 4.3,-4 3.6,4 4.3,-4 v -8 l 5,-4 h 5.1 v 4 h -5.8 v 4 l 2.2,4 z m 363.6,-16 h -10.8 l 8.8,-4 z m -13.6,-8 h -5.6 l -5.2,-8 h 4.4 7.2 z m 8.8,-16 5.6,8 h 9.2 l 10.4,4 v 4 l -3.6,4 -14,4 -2,-12 h -3.6 l -5.2,-4 v -4 z m 333.3,36 3,12 -4,-12 2,-16 v -4 l 3,-8 3,-4 3,-8 h 3 l -7,12 -5,12 z m -348.5,-44 1.2,4 h 9.6 l -6,4 h -19.2 l 3.6,-4 h 9.2 z m -445.8,4 h -5 l -7.2,-8 h 10 2.2 z m 419,-8 -0.8,4 h -7.2 -5.6 -7.2 l -5.2,-12 7.2,-4 4.4,-4 6,8 0.4,4 3.2,4 z m -464.4,-12 -3.6,4 -3.6,-4 1.5,-4 3.6,4 z m 367.2,-12 -4.8,4 h -3.2 l 0.8,-4 5.2,-4 h 2.8 z m 26.8,0 h -10 l -6.8,-4 0.8,-4 8,-4 h 7.2 l 5.2,4 z m 544.7,-28.3 -13,8.3 10,-8.3 z m -924.3,-8 5.1,4 h 5 l 1.4,4 7.2,4.3 -8.6,4 -3.6,-8.3 H 211 Z m 1039.3,-8 -5,3.6 -8,-3.6 6,-3.2 z m -931.3,-86.4 0.8,5.6 3.6,-4.4 4.3,5.2 6.5,-2.4 2.8,1.6 0.8,2.8 2.8,2.8 11.6,-2.8 9.3,4.4 10.1,-0.8 4.3,2.8 7.9,-4.8 14.4,5.6 27.6,135.1 8.4,4 4.4,-4 0.8,4 14.4,8 0.8,4 5.6,-4 1.6,-8 4.8,-4 h 4.4 l 1.6,4 v 4 l 14.4,8 15.6,16 6,4 10,4 h 9.2 l -0.8,4 4.4,8 -2.8,8 -4.4,-4 -4.4,4 -4.8,-8 h -2.8 l 1.2,4 4.4,8 -4.4,4 h -2 l -11.6,-8 v -8 l -3.6,-4 -0.8,8 h -4.4 v -8 l -2,-4 -0.8,4 h -4.8 l -16,-16 -2.8,-8 -28.8,-12 1.2,-4 h 0.8 -3.6 l -2,4 -9.6,-4 h -11.2 l -10.4,8 1.6,-8 h -13 l -5,-8 h -9.4 -5 l 1.4,4 5,4 -1.4,4 -3.6,4 h -6.5 l -8.6,8 -7.9,4 h -4.4 l 8,-8 h -5.1 -2.9 l 4.4,-8 v -8 l 6.4,-4 2.9,4 5.1,-4 -6.5,-4 h -4.3 l -6.5,8 -5.1,8 h -2.1 v 4 l -2.9,4 h -0.7 l -2.2,4 h -2.9 l -0.7,8 h 4.3 l -3.6,8 -2.8,4 -5.8,4 -2.2,4 h -2.8 l -2.9,4 h -2.9 l -1.4,4 -4.4,4 h -3.6 l -1.4,4 h -5 l -2.2,4 -3.6,4 -4.3,4 h -5.8 -3.6 -0.7 l -5,4 -2.2,-4 h -2.2 l -2.1,4 -2.9,4 h -4.3 -4.4 l -3.6,4 h -5.7 l -8.7,4 -0.7,-4 4.3,-8 h 10.8 5.1 l 9.3,-8 h 7.2 2.2 l 2.2,-4 5.7,-4 8.7,-4 h 2.8 l 2.9,-8 5.1,-4 h 0.7 l 2.2,-12 4.3,-8 -9.4,4 -2.9,-4 -2.8,8 -4.4,-8 h -3.6 l -2.8,-4 -5.1,4 h -3.6 l -2.9,4 -2.8,-4 h 2.1 l -0.7,-8 3.6,-4 -3.6,-8 -6.5,4 -6.5,-4 -6.5,-8 -1.4,-4 2.2,-4 h -1.5 l -2.1,-4 -0.8,-4 -2.1,-4 2.9,-4 2.1,-4 6.5,-4 2.9,-8 h 2.9 5 l 1.5,4 5.7,-4 7.2,-4 h 5.1 l -0.8,-8.3 -3.6,-4 5.1,-4 -0.8,-4 -4.3,0.8 -4.3,2.8 -3.6,4.4 -1.4,-4 -5.1,-0.4 h -7.9 l -7.9,-4 -1.5,-6.8 3.6,-3.6 -10,-5.6 18.7,-8.8 8.6,-1.2 v 6.4 l 11.5,4.4 3.6,-5.2 -1.4,-6.4 2.9,-2.8 -13.7,-3.6 -1.4,-8.8 -12.3,-12 2.9,-2.4 0.7,-5.6 h 13 l 11.5,-16.8 5.8,-0.4 10,-6.8 h 5.8 l 7.9,-7.2 z m -33.1,-155.6 6.5,10.8 -4.3,-2.4 z m -28.8,-52.8 v 4.4 l -5,-2 -0.7,-3.6 z m -9.3,2.8 -5.1,0.8 -2.9,-5.6 5.8,0.8 z m 1549.5,-27.2 1,2 h -3 l -4,3.2 2,-1.6 2,-2.8 z m -4,-233.2 -4,2.8 1,-2.8 v -1.6 -1.2 l 3,-1.6 z m 106,-62.8 -12,3.6 2,-0.8 4,-7.2 z m 15,0.8 -3,0.8 -4,-0.8 4,-1.6 1,-3.6 3,3.2 z m -451,-116 -9,3.6 -3,-1.2 6,-4.4 2,-2.4 z m -170,-64.8 -4,3.6 -4,-1.2 2,-3.2 8,-4 10,-7.2 v 3.6 l -3,3.6 z M 333.4,81.9 v 3.6 l -6.5,-5.2 1.5,-4.8 -3.6,-4.4 5,-1.6 -0.7,10 z M 321.9,56.7 h -4.3 l -0.8,-4.4 h 3.7 z m 8.6,-3.6 -2.9,2 -5,-2.8 3.6,-2 z m 80,7.2 32.4,8 17.2,4 21.6,5.2 10.8,2.8 28,6 36.8,7.6 18.8,3.6 29.6,6 22.8,3.6 26,4.4 15.2,2.8 35.2,4.8 36,5.2 29.6,3.6 30.8,3.6 29.6,2.8 28.8,2.4 31.6,2.8 26.8,1.6 14.4,1.2 38,1.6 18.8,0.8 14.7,0.4 30,0.8 21,0.8 h 24 31 5 l -1,-16.8 6,0.8 3,2.8 5,17.6 v 4.4 l 2,2.8 6,0.8 4,2 12,0.8 2,4.4 9,-1.6 v -1.6 l 8,-2.8 3,0.8 h 2 l 8,3.6 3,4.4 4,-0.8 4,9.2 3,-0.4 v -4.4 l 3,-1.6 5,2.4 -1,2 7,2 3,3.6 8,3.2 5,-2.4 6,-4.4 4,-2.8 4,6 h 11 l 7,-1.6 4,0.8 3,4.4 5,-2.4 3,1.6 -4,4.4 -5,2.8 -17,6.4 -5,3.6 -8,7.2 -12,15.2 -4,2 -6,6.4 -8,7.2 2,3.2 7,0.4 7,-2.8 13,-5.6 7,-4.4 3,2.8 -4,6 v 7.2 l 6,-3.6 5,3.6 h 4 l 11,-5.2 4,-4.4 3,-2 10,-2.4 6,-2.8 2,-3.6 6,-2 2,-3.6 10,-8.8 2,-3.6 7,-4.4 11,-1.2 v 3.6 l -6,4.4 -6,4 -5,12.4 1,5.6 5,-6.4 6,0.8 h 4 l 7,2 6,8 6,6 6,-0.8 4,-1.6 5,2.8 6,0.8 2,-3.6 11,-8.4 8,-2.4 11,-0.8 7,-3.6 8,-1.2 -1,10.8 1,1.2 h 8 l 4,-1.2 3,2 3,-3.6 9,-1.2 -1,3.6 2,10 8,8.4 h -6 -4 l -6,2.4 v -2.4 l -7,-1.2 -4,8.4 -6,-4.8 -10,-2.8 -6,0.4 -3,5.2 -7,1.6 -1,2 -8,-0.8 -4,2.8 -1,5.2 -2,1.6 -3,0.4 -2,6 -2,-1.6 4,-8.4 h -7 l -2,6.4 -3,2 -3,-1.2 -5,7.6 -5,12.4 -4,5.6 v 2.4 l -1,4.8 -3,0.8 -4,6.4 -2,6.8 -1,5.6 3,0.8 5,-6 v -1.2 l 4,-7.2 5,-2.4 5,-12.8 6,-2 v 4.8 l -2,1.6 -2,8.4 -4,3.6 v 5.2 l -3,7.2 -2,8.8 2,5.6 -4,3.6 -1,9.2 1,8.8 -2,6.4 -3,13.2 1,2.8 3,14.4 3,2.8 -1,5.2 1,7.2 -1,8.4 3,6 3,2.8 3,10 3,5.6 5,3.2 h 5 l 9,-5.2 3,-2 6,-6.8 4,-10 3,-5.6 2,-8 1,-15.2 -2,-9.2 -2,-6 -5,-7.6 -3,-6.8 -3,-5.6 3,-9.2 -4,-10.4 3,-4.8 3,-8 1,-7.2 -1,-8 4,-3.6 v -5.6 l 4,-2.8 h 4 l 1,-4.4 5,-1.6 v 13.2 l 3,0.4 2,-4.8 2,-2.8 v -8 l -2,-4.4 v -2.8 l 5,-4.4 3,-0.8 -1,-8.4 4,-6.8 6,-3.6 9,4.4 4,-0.8 3,0.8 4,5.2 h 6 l 3,2 13,4.4 2,3.6 2,2.8 -4,5.2 2,4.4 3,2 3,5.6 v 9.6 7.2 l -5,3.6 -1,4.8 -2,8 -6,0.8 -1,3.6 -1,6.4 2,2.8 7,3.2 7,-6.8 1,-4.8 3,-6.4 6,-2.4 4,-2.8 6,2 5,6.8 1,5.6 4,10.8 3,10.8 3,8 v 2 7.2 7.2 l -5,2.4 -2,-5.2 -3,2.8 v 8 l -2,4.4 -4,2 -1,3.6 1,6.4 -2,3.2 -7,10.8 v 2.8 l 10,3.6 7,3.6 -2,2.8 4,0.8 7,-2.4 7,2.4 4,-2.4 3,-0.4 7,-5.2 2,0.8 7,-0.8 7,-7.2 6,-6.4 8,-5.2 14,-8 6,-3.6 16,-12.8 8,-8 4,-4.4 5,-3.6 2,-5.6 5,-4.4 -1,-3.6 -6,-8.4 -3,-7.2 13,-7.2 5,-1.6 14,-2 7,-0.8 7,2.8 6,-2 6,-2.4 6,-0.8 7,-4 2,-3.6 6,-6 3,-0.8 3,-2.8 -1,-4.4 -2,-5.6 2,-5.6 -5,-1.6 -4,-4.4 1,-4.4 4,-4 8,-7.2 2,-5.2 10,-16.4 8,-8.8 5,-2 h 3 l 20,-4.4 21,-6 4,-1.2 19,-4.4 19,-5.2 13,-2.8 v -10 l 2,-3.6 6,1.6 v -3.2 l 4,-2.8 4,1.6 -1,-5.2 5,-1.2 -3,-3.2 v -3.6 l 3,-4.8 3,-3.6 -1,-2.8 3,-4.4 1,-2.8 -4,-3.2 1,-5.6 -2,-1.6 1,-6.4 4,-4.8 -1,-6.8 -1,-4.8 13,-38.4 6,0.8 1,7.2 5,0.8 8,-6.4 6,-1.6 v -3.6 l 3,-0.8 10,4.4 6,3.6 14,46 3,10.8 6,1.6 6,-0.8 -1,5.2 3,2.8 v 5.2 l 6,4.8 1,-2.8 h 4 l 10,12.4 -4,8.4 -4,0.8 -2,3.6 h -4 v 4.4 l -8,2.8 -3,2.8 1,2.8 -2,3.6 -3,-4.8 -5,1.2 5,4.4 -1,2.8 -6,1.6 v -6.4 l -6,3.6 1,4.8 -5,-0.4 -2,1.2 -2,-9.2 v 2.8 l -4,2.8 2,4.4 -1,3.6 v 7.2 l -1,7.2 -6,-1.6 -2,1.6 v 6.4 l -6,0.8 -1,5.2 h -4 l -5,2.8 -3,-0.8 -2,5.2 3,4 -4,2.4 1,4.4 -4,4.8 -1,13.2 -1,0.4 -1,8.8 3,7.2 5,2.8 -6,3.6 -2,6 -1,5.6 h 1 l 4,0.8 2,-0.8 1,0.8 7,4.8 -1,5.2 6,1.6 1,4 6,2.4 4,-2.4 6,-2.8 4,3.6 -15,7.2 v 2.8 l -6,2.4 -1,-8 -6,5.2 -1,4 -5,3.6 -7,0.8 3,-7.2 -2,-1.2 h -4 l -2,-0.8 1,4.4 1,7.6 v 5.2 l -12,5.2 -3,0.4 -11,5.3 -1,-1.5 -5,3.4 -12,2.4 -5,6.5 -3,0.7 -6,6.5 -7,4.3 -2,4.8 v 3.8 l 2,0.6 v -4.2 l 4,-2.8 4,1.4 1,-4.4 6,0.8 5,-3.6 13,-4.4 6,-6.4 5,1.2 3,-1.2 3,2 3,-4.4 h 3 l -16,13.6 -22,14.7 -5,2.5 -4,1.6 -7,1.6 -5,2 -4,-1.2 v -3.6 l 5,-5.8 -6,5.3 v 0.5 l -4,3.6 v 0.8 1.2 l -2,5.2 3,1.2 h 8 l 1,4.4 v 8.8 l 1,15.2 -2,10 -3,2 1,2.8 -2,4.4 -4,3.6 -3,6 -2,8.4 -3,4.4 -2,-3.6 1,-3.6 -1,-3.6 -9,-0.8 -9,-4.8 -5,-2.4 -2,-5.6 v -0.8 l 3,-8.8 v 0 l -2,0.8 -2,9.6 1,4.8 3,4.4 4,1.6 2,4.8 1,6 4,3.6 5,4.8 4,0.8 4,13.6 -1,16 -1,3.6 -2,6.4 h -2 l -4,8 v 7.2 l -1,4.8 -2,12.4 -5,4.4 -2,-5.2 v -13.6 l 2,-8 2,-2.8 1,-8.8 -8,0.8 3,-3.6 -4,-4.8 1,-3.2 h -3 v -4.8 l -4,7.2 -6,-4.4 -2,0.8 -4,-4.4 3,-2.8 -3,-3.6 4,-1.6 5,1.6 -8,-4.4 -3,-0.8 v -3.6 l 3,-1.2 -1,-4.4 v -6.4 l -4,-1.6 2,-8 1,-2.8 4,-0.8 -1,-8 -3,1.6 v 4.4 l -5,6.4 -3,-2.8 1,2 -2,6.4 -3,-0.4 v 1.2 l 4,2.4 v 6.4 l 1,2 -2,8.8 2,1.2 2,7.2 5,6 -2,2.8 h 3 l 3,7.2 -5,1.6 -4,-3.2 -7,-0.4 -2,-3.6 -2,2.8 -5,-6 -6,5.2 -2,-5.2 2,-7.2 -3,-0.4 -1,7.2 2,6.4 2,0.8 7,-3.6 1,4 2,2.4 4,1.2 8,-0.4 3,4 11,3.6 -1,3.6 v 6 l -1,2.8 h -6 l -4,-5.6 h -2 l -9,-6.8 10,8.8 2,0.8 4,4.8 7,2.4 4,2 -1,6 -4,-3.2 -1,2.4 4,3.6 -4,2 3,2.8 5,1.6 v 4.4 l -3,1.2 -8,-4 v -1.6 h -5 l -5,-2 -2,1.2 9,2.4 1,2.8 7,3.6 v 1.2 h 4 2 l 1,-3.6 4,0.8 6,-0.8 8,15.2 6,12.4 -1,0.8 -3,-8 -3,-2.4 v 10.4 2.8 l -6,-2.8 h -2 l 5,2.8 -3,4.4 -3,-2.4 2,2.4 -7,3.6 -4,3.6 -4,-0.8 -2,-3.6 v -6.4 l -1,2 v 4.4 l 3,8 5,-0.8 5,-2.8 2,2 6,-4.4 4,-0.8 2,3.2 -1,3.6 2,7.2 h 1 l -1,-9.6 3,-4.8 5,3.6 3,7.2 -1,5.6 -4,-0.8 -5,11.6 -6,2.8 -5,0.8 -6,-3.6 3,-5.2 -6,3.2 3,4.8 -1,2.4 6,2.8 -2,7.2 -4,4.8 -3,2.4 -5,-2.8 v 3.6 l 7,1.2 3,-2.8 6,-2.8 6,4.4 -3,4.8 -5,3.6 -10,1.6 -7,3.6 -6,7.2 -5,5.6 -6,7.2 -3,6.4 -2,10.8 -2,2.4 h -4 l -9,1.2 -6,3.6 -8,6.8 -6,7.6 -2,4.4 -2,8 v 6.4 l -2,2.8 -2,5.2 -8,0.8 1,4.8 -4,5.2 -5,3.6 v 2.8 l -4,3.6 -4,1.6 -4,3.6 -3,2 -5,0.8 2,3.6 v 3.6 l -7,5.6 -2,3.6 -4,3.2 v 2 l -1,5.6 -6,8.8 -3,0.8 4,3.6 -2,2.8 1,2 -4,7.2 1,3.2 1,2.8 -4,4.8 v 5.2 l 2,4.4 -1,8.8 1,7.6 5,10.8 8,19.6 2,4.4 6,9.2 6,11.6 12,13.6 7,7.2 3,5.2 -2,2.8 v 6.4 l 3,4 5,12.3 7,12 7,12 7,12 3,4 1,8 v 12 l 1,16 2,8 -5,4 -2,12 2,4 -2,4 v 0 0 l 4,-4 -3,12 -5,-4 h -3 l -5,4 h -6 -1 l -7,4 -4,-4 1,-8 -3,-4 -4,-4 -2,-4 -8,-4 -6,-4 -2,4 -6,-12 -3,-8 -8,-8 h -5 l 1,-8 v -4 l -3,-4 h -2 l 2,8 h -2 -3 l -5,-8 -7,-8 -6,-8 -3,-4 h 3 l 3,-8 4,-8 -1,-4 -4,4 -2,-4 -3,-4 v 4 l 3,4 -1,8 h -4 l -6,-8 2,-4 -2,-8 2,-4 2,-8.3 v -4 l -1,-6.4 -4,-5.6 1,-3.6 -2,-3.2 -4,-6.4 h -6 l -8,-4.4 -2,-4.8 -7,-3.6 -1,-6 -3,-0.4 -5,-3.6 -4,-6 -9,-3.6 -3,-1.2 h -4 l -6,0.4 -6,6 -4,3.6 -11,8.4 -9,2.4 -4,1.2 -4,0.8 v -4.8 l -3,-5.2 -5,-1.6 -3,-2.8 -16,-8 -8,-2 -8,-1.6 -8,0.8 -6,0.8 -5,1.6 -8,2 -6,0.8 -7,2.8 -5,1.6 -4,-1.6 -6,-4.4 -2,-10 -3,-1.6 -3,5.2 v 8.8 l -2,0.4 -6,-1.2 -2,1.2 -2,2.4 -8,-0.8 -3,0.8 -5,-2.8 -15,6.4 -2,-2.8 v 2.8 l -6,5.6 -4,1.6 -3,3.6 -5,2.8 1,2.8 5,2.8 3,-0.4 1,-5.2 3,-2 3,2.8 4,2 -6,12.4 -1,-0.8 h -1 l -5,1.6 1,4 8,5.2 10,1.6 7,8.4 -1,4 h -9 l -7,-8 -7,-0.8 -5,-1.6 1,-2 -8,-3.2 -2,3.6 v 0.8 0.8 l -3,2.4 2,4 v 0 l -5,4 -4,-8 h -4 -5 l -4,8 -7,4.3 -4,-4.3 h -4 l -9,-4 2,-8 h -1 l -4,-2 -4,1.6 -6,-11.6 -9,0.8 1,-4.4 h -5 l -6,4.4 -3,0.4 2,6.8 -6,2 -11,-1.6 -14,-5.6 -8,-2 -11,0.4 -10,1.6 -3,2 -9,1.6 -11,4.4 v 0.8 h -4 l -2,-0.8 -9,2 2,-4.8 v -5.2 h -4 l -4,3.6 -3,5.6 5,4 -1,8 -5,4.3 h -4 l 1,4 -10,8 -4,4 -10,4 -12,8 -11,4 -2,4 -6,4 -10,8 v -4 h 1 l 5,-4 4,-4 h 6 l -1,-4 -9,4 v -4 h -3 -3 l 2,4 v 4 h -1 l -4,4 -4,-4 -8,8 h 7 l -3,4 v 4 h -1 -11 -2 4 l 2,4 3,4 -3,4 -3,12 -4,-4 -4,4 h -5 l 8,4 5,-4 -2,20 h -2 l 2,8 4,8 2,8 h -1 l 1,8 h 5 l -3,4 -5,4 h -1 -6 l -4,-4 -8,-4 h -8 -8 l -7.5,-8 h -5.2 -2.8 l -6.4,-4 h -2.4 l -7.2,-4 -0.4,-4 -3.2,-4 -3.6,-12 -6.4,-8 1.6,-4 -1.6,-4 -1.2,-4 1.2,-8 h -1.2 l -3.6,-4 -4.4,-4 -6,-4 -0.4,-4 -3.2,-4 -3.6,-8 h -4.8 l -2.8,-4 -1.6,-8 -3.6,-8 -1.6,-4 -2,-4 -3.6,-8 v -4 l -4.4,-8.3 -8,-4.8 -1.2,-4.4 -3.6,-0.8 -6,-5.2 0.8,-2 -5.6,-5.2 -4.4,-2 -2.8,1.6 -4.4,-1.6 -8,-2 -3.6,1.2 -8.4,-4.8 -3.6,4.8 -3.2,-1.2 -7.6,2 -2.4,5.2 -2.8,3.6 -1.6,6.4 -12.8,17.5 -10,-4.3 -4.4,-8 -6.4,-0.4 -2.4,-3.6 -8.4,-2.8 -5.2,-3.6 -1.2,-4.4 -4.4,-1.2 -6.4,-6 -0.8,-4 -4.4,-8 -0.8,-6.4 1.6,-5.2 -3.6,-8.8 -2.4,-0.4 -0.4,-8 -2.4,-2.8 -8,-8.8 -6.4,-2 -0.8,-2.4 -4.8,-4.4 -1.6,-4 -5.6,-4.4 -2.8,-6 -4.4,-4.4 -2.4,-0.4 -4.8,-4.4 -5.2,-11.6 -4.8,-2.8 -27.6,-2.8 -33.2,-4.4 -2.8,19.2 -30,-4 -51.2,-7.2 -22.4,-3.6 -10,-6 -29.6,-17.2 -36.8,-20.8 -30,-18.8 -18.8,-10.8 1.2,-5.2 4.4,-3.6 -49.6,-5.6 -36.8,-5.2 -0.7,-5.6 -2.9,-2 2.2,-7.2 -0.7,-10.8 -3.6,-10.4 -2.9,-3.6 -5,-7.6 -4.4,-3.6 -5,-7.2 h -6.5 l -4.3,-4.4 2.2,-2.4 -0.8,-4.8 -3.6,-5.2 h -8.6 l -4.3,-2.8 -7.9,-6.4 -0.8,-6 -5.7,-6.4 -2.9,-2 -10.8,-2.8 -3.6,-3.2 -9.4,-2.8 -6.4,-0.8 -0.8,-3.6 -3.6,-3.6 2.9,-4.8 1.5,-11.6 1.4,-6.4 -7.2,-7.2 2.9,-6.4 -3.6,-3.6 -3.6,-8.8 -2.9,-2 -1.4,-6 -2.9,-4.8 v -6 l -2.2,-1.2 -2.9,-8 -2.8,-2.8 -1.5,-11.6 2.2,-6.4 4.3,0.4 2.2,-7.6 -2.2,-6.8 h -5 l -4.4,-4.8 -0.7,-4.4 -2.9,-4.4 2.2,-6.4 -0.7,-6.4 -1.5,-1.6 2.9,-8 0.7,-2.8 3.6,-0.8 -0.7,4.4 -0.7,6 3.6,1.2 2.9,6 2.9,0.4 -2.2,-2 0.7,-7.2 -4.3,-7.2 1.4,-3.6 -2.1,-4.4 5.7,-2 -2.8,-5.2 -3.6,0.8 -3.6,12.4 -5.8,-5.2 -2.9,-5.6 -2.9,-2.4 0.8,-5.6 v -6 l -2.2,-7.6 -5,-7.2 -3.6,-10.4 -2.9,-4 -1.5,-5.2 2.9,-3.6 -0.7,-13.6 4.3,-8 0.7,-12.4 -2.8,-8.4 -1.5,-5.2 -2.1,-2 -4.4,-7.2 1.5,-8 4.3,-6.4 8.6,-8.8 3.6,-5.6 -0.7,-2.8 3.6,-6 3.6,-9.2 0.7,-12.4 -2.1,-2 4.3,-8.8 -2.9,-6.4 v -5.6 l 1.5,-8 2.8,-6 0.8,-3.6 -2.2,-8.4 3.6,-4.4 7.2,-11.6 5,-6.4 4.4,-6.4 4.3,-10 6.5,-16.8 6.4,-15.2 1.5,-5.6 5,-9.2 2.2,-4.4 8.6,-24 v -2 l 4.3,-11.6 3.6,-2.8 10.1,-1.6 -5,-2.8 -5.1,0.8 -2.1,-3.6 1.4,-6.4 3.6,-1.6 -0.7,-8.8 -1.4,-4 1.4,-3.2 3.6,-1.2 v -5.2 l -3.6,-0.8 0.7,-11.2 -1.4,-6 1.4,-4.8 v -9.6 l -2.9,-7.2 -0.7,-4.8 0.7,-8 4.4,-6 2.8,-0.4 4.4,4.8 3.6,2.4 4.3,4.8 9.3,3.6 7.2,4.4 5.1,1.6 2.9,-1.6 2.1,4.4 2.9,1.2 5,-2 2.2,2.8 -1.4,10 -7.2,1.6 -2.9,5.2 -2.9,1.2 -2.2,2.8 4.4,-2.8 5,-0.8 3.6,-4.8 5.8,-3.6 -0.8,7.2 -2.8,10 -2.9,3.6 -2.9,5.6 -5,-3.6 v -2 l -2.9,2.8 -0.7,4.4 3.6,4.4 7.2,-6 3.6,-1.2 2.8,-1.6 v -8.4 l 2.9,-8 4.3,-6.4 3.6,-2.4 -2.8,-4.4 v -5.6 -1.6 l 1.4,-1.2 -6.5,-6.4 2.9,-4.4 2.9,2.8 2.1,-7.2 0.8,-3.6 -5.1,-4.4 -1.4,-4.4 2.1,-4 28.1,7.6 24.5,6.8 z";

// Node positions calibrated for the 2000x1200 viewBox US outline
const THREAT_NODES = [
    { cx: 300, cy: 750, name: "NODE_LAX" },
    { cx: 150, cy: 500, name: "NODE_SFO" },
    { cx: 300, cy: 200, name: "NODE_SEA" },
    { cx: 480, cy: 760, name: "NODE_PHX" },
    { cx: 750, cy: 560, name: "NODE_DEN" },
    { cx: 1050, cy: 880, name: "NODE_DFW" },
    { cx: 1250, cy: 450, name: "NODE_ORD" },
    { cx: 1700, cy: 380, name: "NODE_JFK" },
    { cx: 1600, cy: 480, name: "NODE_DCA" },
    { cx: 1480, cy: 1050, name: "NODE_MIA" },
    { cx: 1050, cy: 1000, name: "NODE_IAH" },
];

const USThreatMap = () => {
    const [activeNodes, setActiveNodes] = useState<number[]>([]);

    useEffect(() => {
        const flashInterval = setInterval(() => {
            const newNodes: number[] = [];
            const numNodes = Math.floor(Math.random() * 4) + 1;
            for (let i = 0; i < numNodes; i++) {
                const idx = Math.floor(Math.random() * THREAT_NODES.length);
                if (!newNodes.includes(idx)) newNodes.push(idx);
            }
            setActiveNodes(newNodes);
        }, 1200);
        return () => clearInterval(flashInterval);
    }, []);

    return (
        <div className="w-full flex-1 flex flex-col pt-8 lg:pt-12 lg:pb-0 lg:pl-12 lg:pr-12 border-b-[2px] lg:border-b-0 border-[var(--color-iron)]">
            <div className="flex justify-between w-full font-mono text-xs text-[var(--color-silica)] border-b-[2px] border-[var(--color-iron)] pb-2 mb-8 uppercase font-bold px-8 lg:px-4">
                <span>[ GLOBAL_THREAT_MATRIX ]</span>
                <span className="text-[var(--color-alert)] animate-pulse hidden sm:inline-block">ACTIVE_NODE_SYNDICATION</span>
            </div>

            <div className="flex-1 flex items-center justify-center relative w-full px-4 sm:px-8 lg:px-0 py-8 mix-blend-screen opacity-80 min-h-[250px] sm:min-h-[300px]">
                <svg viewBox="0 0 2000 1200" className="w-full h-full drop-shadow-[0_0_15px_rgba(255,255,255,0.1)] overflow-visible" preserveAspectRatio="xMidYMid meet">
                    {/* Grid lines */}
                    <path d="M400,0 V1200 M800,0 V1200 M1200,0 V1200 M1600,0 V1200 M0,300 H2000 M0,600 H2000 M0,900 H2000" stroke="rgba(255,255,255,0.03)" strokeWidth="2" strokeDasharray="16,16" />

                    {/* Accurate US Contiguous Outline */}
                    <path
                        d={US_OUTLINE_PATH}
                        fill="rgba(255,255,255,0.015)"
                        stroke="var(--color-iron)"
                        strokeWidth="4"
                        strokeLinejoin="round"
                    />

                    {/* Targeting Crosshairs at center */}
                    <line x1="1060" y1="560" x2="1060" y2="640" stroke="var(--color-alert)" strokeWidth="2" opacity="0.3" />
                    <line x1="1020" y1="600" x2="1100" y2="600" stroke="var(--color-alert)" strokeWidth="2" opacity="0.3" />
                    <circle cx="1060" cy="600" r="60" fill="none" stroke="var(--color-iron)" strokeWidth="2" strokeDasharray="8 8" opacity="0.4" />

                    {/* Threat Nodes — all aligned around (cx, cy) */}
                    {THREAT_NODES.map((node, i) => {
                        const isActive = activeNodes.includes(i);
                        return (
                            <g key={i}>
                                {isActive && (
                                    <>
                                        <circle cx={node.cx} cy={node.cy} r="56" fill="var(--color-alert)" opacity="0.08" className="animate-ping" />
                                        <circle cx={node.cx} cy={node.cy} r="32" fill="none" stroke="var(--color-alert)" strokeWidth="2" opacity="0.35" />
                                    </>
                                )}
                                <circle
                                    cx={node.cx}
                                    cy={node.cy}
                                    r={isActive ? 10 : 5}
                                    fill={isActive ? "var(--color-alert)" : "var(--color-iron)"}
                                    className="transition-all duration-300"
                                    style={{ r: isActive ? 'clamp(10px, 2vw, 15px)' : 'clamp(5px, 1vw, 8px)' }}
                                />
                                {isActive && (
                                    <>
                                        <line x1={node.cx} y1={node.cy} x2={node.cx + 60} y2={node.cy - 50} stroke="var(--color-alert)" strokeWidth="2" opacity="0.5" />
                                        <text x={node.cx + 66} y={node.cy - 44} fill="var(--color-alert)" fontSize="22" fontFamily="monospace" fontWeight="bold" className="text-[32px] sm:text-[22px]">
                                            [{node.name}]
                                        </text>
                                    </>
                                )}
                            </g>
                        );
                    })}
                </svg>
            </div>

            <div className="flex justify-between w-full font-mono text-[10px] text-[var(--color-iron)] border-t-[2px] border-[var(--color-iron)] py-3 mt-auto px-8 lg:px-4 font-bold">
                <span>TOPOLOGY: AKAWA_US_MAINNET</span>
                <span>LATENCY_SIG: &lt;4ms</span>
            </div>
        </div>
    );
};


export default function LandingPage() {
    const [telemetry, setTelemetry] = useState({
        nodesLine: 0,
        activeStreams: 0,
        latency: 0,
    });

    const [activeCam, setActiveCam] = useState(1);
    const [anomalyDetected, setAnomalyDetected] = useState(false);

    // DOM refs for direct manipulation (bypasses React render loop)
    const cursorRef = useRef<HTMLDivElement>(null);
    const heroRef = useRef<HTMLElement>(null);
    const bgTextRef = useRef<HTMLDivElement>(null);
    const mousePosRef = useRef({ x: 0, y: 0 });

    useEffect(() => {
        const interval = setInterval(() => {
            setTelemetry({
                nodesLine: Math.floor(Math.random() * (4084 - 3900 + 1)) + 3900,
                activeStreams: Math.floor(Math.random() * (24 - 12 + 1)) + 12,
                latency: Math.floor(Math.random() * (12 - 4 + 1)) + 4,
            });
        }, 800);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        const camInterval = setInterval(() => {
            setActiveCam(prev => prev === 4 ? 1 : prev + 1);
            setAnomalyDetected(Math.random() > 0.6);
        }, 1500);
        return () => clearInterval(camInterval);
    }, []);

    // Vanilla JS mouse cursor follower (RAF, no React state)
    useEffect(() => {
        let animFrame: number;
        const cursorEl = cursorRef.current;
        if (!cursorEl) return;

        const onMouseMove = (e: MouseEvent) => {
            mousePosRef.current = { x: e.clientX, y: e.clientY };
        };
        const animate = () => {
            const { x, y } = mousePosRef.current;
            cursorEl.style.transform = `translate3d(${x - 64}px, ${y - 64}px, 0)`;
            animFrame = requestAnimationFrame(animate);
        };
        window.addEventListener("mousemove", onMouseMove, { passive: true });
        animFrame = requestAnimationFrame(animate);
        return () => {
            window.removeEventListener("mousemove", onMouseMove);
            cancelAnimationFrame(animFrame);
        };
    }, []);

    // Vanilla JS scroll-driven parallax (RAF-throttled, direct DOM)
    useEffect(() => {
        let ticking = false;
        const onScroll = () => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                const scrollY = window.scrollY;
                // Hero fade + parallax
                if (heroRef.current) {
                    const opacity = Math.max(0, 1 - scrollY / 400);
                    const translateY = scrollY * -0.3;
                    heroRef.current.style.opacity = String(opacity);
                    heroRef.current.style.transform = `translate3d(0, ${translateY}px, 0)`;
                }
                // Background text parallax
                if (bgTextRef.current) {
                    const bgY = scrollY * -0.5;
                    bgTextRef.current.style.transform = `translate3d(0, ${bgY}px, 0)`;
                }
                ticking = false;
            });
        };
        window.addEventListener("scroll", onScroll, { passive: true });
        return () => window.removeEventListener("scroll", onScroll);
    }, []);

    const [problemRef, problemInView] = useInView({ threshold: 0.2 });
    const [axiomRef, axiomInView] = useInView({ threshold: 0.2 });

    const mainRef = useRef<HTMLElement>(null);

    // GSAP ScrollTrigger reveal animations
    useEffect(() => {
        if (!mainRef.current) return;
        const ctx = gsap.context(() => {
            // Staggered reveal for each major section
            gsap.utils.toArray<HTMLElement>(".gsap-reveal").forEach((el) => {
                gsap.fromTo(el,
                    { y: 60, opacity: 0 },
                    {
                        y: 0, opacity: 1, duration: 0.8, ease: "power3.out",
                        scrollTrigger: { trigger: el, start: "top 88%", toggleActions: "play none none none" },
                    }
                );
            });
            // Staggered children reveal
            gsap.utils.toArray<HTMLElement>(".gsap-stagger-parent").forEach((parent) => {
                const children = parent.querySelectorAll(".gsap-stagger-child");
                gsap.fromTo(children,
                    { y: 40, opacity: 0 },
                    {
                        y: 0, opacity: 1, duration: 0.6, stagger: 0.12, ease: "power2.out",
                        scrollTrigger: { trigger: parent, start: "top 85%", toggleActions: "play none none none" },
                    }
                );
            });
            // Horizontal wipe reveals
            gsap.utils.toArray<HTMLElement>(".gsap-wipe").forEach((el) => {
                gsap.fromTo(el,
                    { clipPath: "polygon(0 0, 0 0, 0 100%, 0 100%)" },
                    {
                        clipPath: "polygon(0 0, 100% 0, 100% 100%, 0 100%)", duration: 0.6, ease: "power2.inOut",
                        scrollTrigger: { trigger: el, start: "top 85%", toggleActions: "play none none none" },
                    }
                );
            });
            // Scale-up counters
            gsap.utils.toArray<HTMLElement>(".gsap-counter").forEach((el) => {
                gsap.fromTo(el,
                    { scale: 0.5, opacity: 0 },
                    {
                        scale: 1, opacity: 1, duration: 0.5, ease: "back.out(1.7)",
                        scrollTrigger: { trigger: el, start: "top 90%", toggleActions: "play none none none" },
                    }
                );
            });
        }, mainRef);
        return () => ctx.revert();
    }, []);

    const [renderId, setRenderId] = useState("");
    useEffect(() => {
        setRenderId(Math.random().toString(36).substring(7).toUpperCase());
    }, []);

    return (
        <div className="min-h-screen flex flex-col font-sans uppercase tracking-wide selection:bg-[var(--color-alert)] selection:text-[var(--color-void)] relative overflow-hidden bg-[var(--color-void)]">

            <div
                ref={cursorRef}
                className="fixed w-32 h-32 pointer-events-none z-40 top-0 left-0 mix-blend-exclusion hidden md:block will-change-transform"
            >
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1px] h-4 bg-[var(--color-alert)]"></div>
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[1px] h-4 bg-[var(--color-alert)]"></div>
                <div className="absolute left-0 top-1/2 -translate-y-1/2 h-[1px] w-4 bg-[var(--color-alert)]"></div>
                <div className="absolute right-0 top-1/2 -translate-y-1/2 h-[1px] w-4 bg-[var(--color-alert)]"></div>
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 bg-[var(--color-data)]"></div>
            </div>

            <div
                ref={bgTextRef}
                className="fixed inset-0 pointer-events-none z-0 opacity-[0.03] font-mono leading-none text-6xl md:text-9xl text-[var(--color-data)] break-all flex flex-wrap content-start select-none will-change-transform"
            >
                {'01010111 01000101 01000001 01010000 01001111 01001110 00100000 01010011 01011001 01010011 01010100 01000101 01001101 00100000 '.repeat(100)}
            </div>

            <header className="nav-border py-2 px-4 flex justify-between items-center bg-[var(--color-void)] z-50 sticky top-0 relative">
                <div className="absolute inset-0 pointer-events-none terminal-overlay opacity-30"></div>

                <div className="flex items-center gap-8 relative z-10">
                    <div className="font-mono font-bold text-xl text-[var(--color-data)] flex items-center gap-2">
                        <div className="w-3 h-3 bg-[var(--color-alert)] animate-[pulse_1s_ease-in-out_infinite]" />
                        <span className="font-mono">AKAWA_OS</span>
                    </div>
                    <nav className="hidden md:flex gap-6 font-mono text-[10px] text-[var(--color-silica)]">
                        <span className="hover:text-[var(--color-data)] hover:bg-[var(--color-data)] hover:text-black px-1 transition-none cursor-crosshair">SYS_STATUS: ONLINE</span>
                        <span className="hover:text-[var(--color-data)] hover:bg-[var(--color-data)] hover:text-black px-1 transition-none cursor-crosshair">VER: 2026.4.1</span>
                        <span className="text-[var(--color-alert)] bg-transparent hover:bg-[var(--color-alert)] hover:text-black px-1 transition-none group relative cursor-help">
                            RESTRICTED_ACCESS
                        </span>
                    </nav>
                </div>
                <div className="flex items-center gap-4 relative z-10">
                    <Link href="/login" className="font-mono text-[10px] sm:text-xs text-[var(--color-silica)] hover:bg-[var(--color-data)] hover:text-black px-2 transition-none underline decoration-[var(--color-iron)] underline-offset-4 hover:no-underline">
                        SYSTEM_LOGIN
                    </Link>
                    <Link href="/signup" className="btn-alert text-[10px] sm:text-xs !py-1">
                        INITIALIZE_WORKSPACE
                    </Link>
                </div>
            </header>

            <main ref={mainRef} className="flex-1 flex flex-col border-x-[2px] border-[var(--color-iron)] mx-4 md:mx-8 my-4 relative z-10">

                {/* HERO SECTION */}
                <section
                    ref={heroRef}
                    className="grid grid-cols-1 md:grid-cols-4 border-b-[2px] border-[var(--color-iron)] bg-[var(--color-void)] relative z-20 will-change-[transform,opacity]"
                >
                    <div className="md:col-span-3 p-8 md:p-12 lg:p-16 border-b-[2px] md:border-b-0 md:border-r-[2px] border-[var(--color-iron)] relative bg-[var(--color-dim)] flex flex-col justify-center">
                        <div className="absolute inset-0 bg-[linear-gradient(rgba(51,51,51,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(51,51,51,0.5)_1px,transparent_1px)] bg-[size:32px_32px] opacity-20 pointer-events-none" />

                        <div className="relative z-10 mix-blend-difference animate-slide-in-bottom">
                            <h1 className="text-[2.8rem] sm:text-7xl md:text-8xl lg:text-[7rem] xl:text-[9rem] font-bold leading-[0.9] mb-8 text-[var(--color-data)] tracking-tighter overflow-hidden animate-float-subtle-large break-all sm:break-normal">
                                <ScrambleText text="ABSOLUTE" delay={500} /><br />
                                <span className="text-[var(--color-alert)] mix-blend-screen"><ScrambleText text="VIGILANCE" delay={1000} /></span><span className="text-[var(--color-alert)] animate-pulse">_</span>
                            </h1>

                            <div className="max-w-2xl font-mono text-xs sm:text-sm leading-relaxed mt-10 mb-10 border-[1px] border-[var(--color-iron)] bg-[var(--color-void)] p-4 shadow-[4px_4px_0px_var(--color-iron)] hover:border-[var(--color-data)] hover:shadow-[4px_4px_0px_var(--color-data)] transition-colors animate-slide-in-bottom stagger-1 z-10 relative cursor-crosshair">
                                <div className="font-bold text-[var(--color-data)] mb-2 flex justify-between border-b border-[var(--color-iron)] pb-2">
                                    <span>// PROJECT_AKAWA_OVERVIEW</span>
                                    <span className="hidden sm:inline-block animate-pulse text-[var(--color-alert)]">SYS_READY</span>
                                </div>
                                <p className="text-[var(--color-silica)] uppercase">
                                    An advanced AI-driven threat detection system. Leveraging edge-optimized Computer Vision to identify firearms, aggressive kinetic behaviors, and medical emergencies instantly. Removing the human bottleneck from live surveillance.
                                </p>
                            </div>

                            <div className="max-w-2xl font-mono text-sm leading-relaxed text-[var(--color-silica)] mb-12 border-l-[4px] border-[var(--color-alert)] pl-4 bg-[var(--color-void)] p-4 border-y border-r border-[#333] animate-slide-in-bottom stagger-2 animate-float-subtle">
                                <p className="mb-4 text-[var(--color-alert)] font-bold">// TWO-STAGE ARCHITECTURE:</p>
                                <p>
                                    TRANSFORM PASSIVE CAMPUS HARDWARE INTO AN UNBLINKING PROACTIVE DEFENSE GRID. <span className="text-white font-bold bg-[#333] px-1">YOLOv11</span> FOR RAPID WEAPON CLASSIFICATION. <span className="text-white font-bold bg-[#333] px-1">LMST MODEL</span> FOR KINEMATIC STANCE TRACKING.
                                </p>
                            </div>

                            <div className="flex flex-col sm:flex-row gap-0 animate-slide-in-bottom stagger-3">
                                <Link href="/signup" className="btn-alert text-xl md:text-2xl py-6 px-8 flex-1 text-center font-bold relative overflow-hidden group">
                                    <span className="relative z-10">[ DEPLOY_INSTANCE ]</span>
                                    <div className="absolute inset-0 bg-white translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-in-out z-0"></div>
                                </Link>
                            </div>
                        </div>
                    </div>

                    <div className="md:col-span-1 p-4 font-mono text-[10px] leading-tight flex flex-col gap-4 bg-[var(--color-void)] relative terminal-overlay text-[var(--color-data)]">
                        <div className="border-[1px] border-[var(--color-alert)] p-2 relative z-10 bg-[var(--color-alert)] text-black">
                            <span className="font-bold block mb-1">WARNING: LIVE ENVIRONMENT</span>
                            <span>UNAUTHORIZED ACCESS LOGGED.</span>
                        </div>

                        <div className="data-container flex-1 relative z-10 bg-[var(--color-void)] border-[var(--color-iron)]">
                            <h3 className="border-b border-[var(--color-iron)] pb-2 mb-2 font-bold flex justify-between text-[12px] opacity-80 mt-2 hover:bg-[var(--color-data)] hover:text-black cursor-crosshair">
                                DUAL_CORE_TELEMETRY
                                <span className="text-[var(--color-alert)] animate-[spin_4s_linear_infinite]">/</span>
                            </h3>

                            <div className="data-list text-[var(--color-data)]">
                                <div className="data-list-item hover:bg-[var(--color-data)] hover:text-black px-1 group cursor-crosshair transition-none">
                                    <span>YOLOv11_NODES:</span>
                                    <span>{telemetry.nodesLine}</span>
                                </div>
                                <div className="data-list-item hover:bg-[var(--color-data)] hover:text-black px-1 group cursor-crosshair transition-none">
                                    <span>BEHAVIORAL_TRACKERS:</span>
                                    <span>{Math.floor(telemetry.nodesLine * 0.4)}</span>
                                </div>
                                <div className="data-list-item hover:bg-[var(--color-alert)] hover:text-black px-1 group cursor-crosshair transition-none">
                                    <span>AVG_LATENCY:</span>
                                    <span>{telemetry.latency}ms</span>
                                </div>
                                <div className="data-list-item hover:bg-[var(--color-data)] hover:text-black px-1 group cursor-crosshair transition-none">
                                    <span>MEMORY_ALLOC:</span>
                                    <span>DEDICATED_VRAM</span>
                                </div>
                            </div>
                        </div>

                        <div className="h-48 border border-[var(--color-iron)] overflow-hidden bg-[var(--color-dim)] p-2 text-[8px] text-[var(--color-iron)] break-all relative z-10 cursor-not-allowed">
                            <div className="animate-data-scroll">
                                {'DATA_INGESTION_NOMINAL_X0_VRAM_ALLOCATED_892211_FRAME_SYNC_ESTABLISHED_THREAT_MATRIX_LOADING_01010101_'.repeat(30)}
                            </div>
                        </div>
                    </div>
                </section>

                {/* Simulated Feed */}
                <section
                    className="border-b-[2px] border-[var(--color-iron)] relative bg-[var(--color-void)] flex-1 relative z-10"
                >
                    <div className="bg-[var(--color-dim)] p-2 md:p-4 border-b-[2px] border-[var(--color-iron)] flex justify-between items-center text-[var(--color-data)]">
                        <h2 className="font-mono text-sm md:text-xl font-bold flex items-center gap-4">
                            <span className="w-4 h-4 bg-[var(--color-alert)] animate-[pulse_0.5s_ease-in-out_infinite]" />
                            [ HIGH_RES_MUX ] ACTIVE_SURVEILLANCE
                        </h2>
                        <span className="font-mono text-[10px] px-2 py-1 border border-[var(--color-iron)] bg-[var(--color-void)] hidden md:inline-block">ROTATION_ENABLED</span>
                    </div>

                    <div className="aspect-video sm:aspect-[21/9] min-h-[300px] md:min-h-[500px] w-full bg-[#050505] relative overflow-hidden flex items-center justify-center p-8">
                        <div className="absolute inset-0 bg-[linear-gradient(rgba(51,51,51,0.8)_1px,transparent_1px),linear-gradient(90deg,rgba(51,51,51,0.8)_1px,transparent_1px)] bg-[size:60px_60px] z-0 opacity-40" />
                        <div className="absolute inset-0 terminal-overlay z-20 pointer-events-none mix-blend-overlay" />

                        <div className="absolute inset-4 md:inset-8 border-[2px] border-[var(--color-iron)] z-10 flex flex-col justify-between pointer-events-none">
                            <div className="flex justify-between font-mono text-xs md:text-sm text-[var(--color-data)] border-b-[2px] border-[var(--color-iron)] bg-[var(--color-void)]">
                                <span className="px-4 py-2 font-bold bg-[var(--color-data)] text-black">CAM_NODE_{activeCam.toString().padStart(2, '0')}</span>
                                {anomalyDetected ? (
                                    <span
                                        className="bg-[var(--color-alert)] text-black px-4 py-2 font-bold tracking-widest animate-[fadeSlideIn_0.1s_linear]"
                                    >
                                        [ ANOMALY ]
                                    </span>
                                ) : (
                                    <span
                                        className="text-[var(--color-silica)] px-4 py-2 font-normal text-xs flex items-center gap-2"
                                    >
                                        <div className="w-2 h-2 bg-white rounded-full"></div> NOMINAL
                                    </span>
                                )}
                            </div>

                            <div
                                className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 md:w-80 md:h-80 border-[2px] flex items-center justify-center transition-all duration-100 ${anomalyDetected ? 'border-[var(--color-alert)] opacity-100 scale-105' : 'border-[var(--color-iron)] opacity-20 scale-100'}`}
                            >
                                <div className="w-full h-[2px] bg-current absolute top-1/2 -translate-y-1/2 opacity-30" />
                                <div className="h-full w-[2px] bg-current absolute left-1/2 -translate-x-1/2 opacity-30" />

                                {anomalyDetected && (
                                    <div
                                        className="border-[3px] border-[var(--color-alert)] absolute top-[15%] left-[55%] flex text-[10px] font-mono text-[var(--color-alert)] uppercase items-start mix-blend-screen bg-transparent shadow-[inset_0_0_20px_rgba(255,51,0,0.2)] animate-[expandBox_0.15s_ease-out_forwards]"
                                    >
                                        <span className="absolute -top-6 -left-[3px] bg-[var(--color-alert)] text-black px-2 py-1 font-bold whitespace-nowrap">ID: THREAT_Y11</span>
                                    </div>
                                )}
                            </div>

                            <div className="flex justify-between font-mono text-[10px] md:text-sm text-[var(--color-data)] border-t-[2px] border-[var(--color-iron)] bg-[var(--color-void)] px-4 py-2">
                                <span className="animate-pulse hidden md:inline">REC [....................]</span>
                                <span suppressHydrationWarning>UTC: {new Date().toISOString().substring(0, 19).replace('T', ' ')}</span>
                            </div>
                        </div>
                    </div>
                </section>

                {/* THE SYSTEMIC FAILURE */}
                <section ref={problemRef} className="gsap-reveal border-b-[2px] border-[var(--color-iron)] bg-[var(--color-alert)] text-black relative pl-0 pt-0 overflow-hidden min-h-[60vh] flex flex-col justify-center">
                    <div className="absolute inset-0 z-0 flex flex-col justify-around opacity-20 pointer-events-none overflow-hidden select-none">
                        {[1, 2, 3, 4, 5].map((i) => (
                            <div key={i} className="flex whitespace-nowrap">
                                <div className={`font-black text-7xl md:text-9xl uppercase leading-none tracking-tighter ${i % 2 === 0 ? 'animate-marquee' : 'animate-marquee-slow'}`}>
                                    {' WARNING: PASSIVE MONITORING IS A FATAL FLAW //'.repeat(10)}
                                </div>
                                <div className={`font-black text-7xl md:text-9xl uppercase leading-none tracking-tighter ${i % 2 === 0 ? 'animate-marquee' : 'animate-marquee-slow'}`}>
                                    {' WARNING: PASSIVE MONITORING IS A FATAL FLAW //'.repeat(10)}
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="relative z-10 p-8 md:p-16 max-w-7xl mx-auto w-full">
                        <div className="font-mono text-xl font-bold mb-8 border-b-4 border-black pb-4 inline-block bg-[var(--color-alert)]">
                            [ CRITICAL_SYSTEM_ERROR ]
                        </div>
                        <h2 className="text-4xl md:text-7xl lg:text-[7rem] font-black tracking-tighter leading-[0.85] mb-16 uppercase overflow-visible">
                            {problemInView ? <ScrambleText text="THE ANATOMY OF" delay={0} durationMultiplier={2} /> : " "}<br />
                            {problemInView ? <ScrambleText text="SYSTEMIC FAILURE" delay={800} durationMultiplier={3} /> : " "}
                        </h2>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-16 mt-8">
                            <div className="border-l-4 border-black pl-6 bg-[var(--color-alert)]/90 p-4 hover:bg-black hover:text-[var(--color-alert)] transition-none cursor-crosshair group animate-float-subtle">
                                <h3 className="text-5xl md:text-7xl font-black mb-2 group-hover:animate-none animate-pulse">99%</h3>
                                <p className="font-mono font-bold text-sm md:text-base leading-tight">OF TRADITIONAL CCTV FOOTAGE IS NEVER WATCHED LIVE. CAMERAS ONLY RECORD HISTORY.</p>
                            </div>
                            <div className="border-l-4 border-black pl-6 bg-[var(--color-alert)]/90 p-4 hover:bg-black hover:text-[var(--color-alert)] transition-none cursor-crosshair animate-float-subtle stagger-1">
                                <h3 className="text-5xl md:text-7xl font-black mb-2">ZERO</h3>
                                <p className="font-mono font-bold text-sm md:text-base leading-tight">PREEMPTIVE ACTION TAKEN BEFORE THE THRESHOLD. REACTIVE SURVEILLANCE ONLY DOCUMENTS THE AFTERMATH.</p>
                            </div>
                            <div className="border-l-4 border-black pl-6 bg-[var(--color-alert)]/90 p-4 hover:bg-black hover:text-[var(--color-alert)] transition-none cursor-crosshair animate-float-subtle stagger-2">
                                <h3 className="text-5xl md:text-7xl font-black mb-2">7 MIN</h3>
                                <p className="font-mono font-bold text-sm md:text-base leading-tight">AVERAGE RESPONSE DELAY DURING ACTIVE CRISES DUE TO HUMAN-IN-THE-LOOP BOTTLENECKS.</p>
                            </div>
                        </div>
                    </div>
                </section>

                {/* OPERATIONAL AXIOMS */}
                <section ref={axiomRef} className="gsap-reveal border-b-[2px] border-[var(--color-iron)] bg-[var(--color-data)] text-black relative">
                    <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[50vh]">
                        <div className="lg:col-span-4 p-8 md:p-16 border-b-[2px] lg:border-b-0 lg:border-r-[2px] border-[var(--color-iron)] bg-[var(--color-void)] text-[var(--color-data)] flex flex-col justify-center">
                            <h2 className="text-5xl md:text-6xl lg:text-5xl xl:text-7xl font-black tracking-tighter leading-none mb-6">AI<br />POWERED</h2>
                            <p className="font-mono text-xs text-[var(--color-silica)]">
                                HUMANS CANNOT MONITOR THOUSANDS OF FEEDS SIMULTANEOUSLY. WE REMOVE THE HUMAN LIMITATION FROM THE DETECTION LOOP.
                            </p>
                        </div>

                        <div className="lg:col-span-8 flex flex-col bg-[var(--color-data)]">
                            <div
                                style={{ clipPath: axiomInView ? 'polygon(0 0, 100% 0, 100% 100%, 0 100%)' : 'polygon(0 0, 0 0, 0 100%, 0% 100%)', transition: 'clip-path 0.2s linear' }}
                                className="flex-1 p-8 md:p-12 border-b-[2px] border-[var(--color-iron)] hover:bg-[var(--color-void)] hover:text-[var(--color-data)] cursor-crosshair flex flex-col justify-center"
                            >
                                <div className="font-mono font-bold text-xs mb-4">AXIOM_01</div>
                                <h3 className="text-3xl md:text-5xl font-black tracking-tighter mb-2 uppercase">Prediction over reaction</h3>
                            </div>

                            <div
                                style={{ clipPath: axiomInView ? 'polygon(0 0, 100% 0, 100% 100%, 0 100%)' : 'polygon(0 0, 0 0, 0 100%, 0% 100%)', transition: 'clip-path 0.2s linear 0.1s' }}
                                className="flex-1 p-8 md:p-12 border-b-[2px] border-[var(--color-iron)] hover:bg-[var(--color-void)] hover:text-[var(--color-data)] cursor-crosshair flex flex-col justify-center"
                            >
                                <div className="font-mono font-bold text-xs mb-4">AXIOM_02</div>
                                <h3 className="text-3xl md:text-5xl font-black tracking-tighter mb-2 uppercase">Machine Consistency</h3>
                            </div>

                            <div
                                style={{ clipPath: axiomInView ? 'polygon(0 0, 100% 0, 100% 100%, 0 100%)' : 'polygon(0 0, 0 0, 0 100%, 0% 100%)', transition: 'clip-path 0.2s linear 0.2s' }}
                                className="flex-1 p-8 md:p-12 hover:bg-[var(--color-void)] hover:text-[var(--color-data)] group cursor-crosshair flex flex-col justify-center"
                            >
                                <div className="font-mono font-bold text-xs mb-4">AXIOM_03</div>
                                <h3 className="text-3xl md:text-5xl font-black tracking-tighter mb-2 uppercase text-[var(--color-alert)] group-hover:text-[var(--color-alert)]">Instant Response</h3>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Threat Vectors & Maps Side-by-Side Architectural Implementation */}
                <section
                    className="gsap-reveal border-b-[2px] border-[var(--color-iron)] bg-[var(--color-void)] flex flex-col lg:flex-row min-h-[600px] lg:h-[600px] overflow-hidden"
                >
                    {/* Left Grid: The Threat Vectors (Flex Directional Expansion) */}
                    <div className="flex flex-col lg:w-1/2 bg-[var(--color-void)] border-r-[2px] border-[var(--color-iron)] h-full">
                        <div className="flex-1 hover:flex-[1.5] transition-all duration-500 ease-[cubic-bezier(0.25,1,0.5,1)] p-8 group-hover:pb-[35px] border-b-[2px] border-[var(--color-iron)] hover:bg-[var(--color-alert)] hover:text-black cursor-crosshair group flex flex-col overflow-hidden relative">
                            <div className="font-mono text-[var(--color-alert)] font-bold text-xs mb-4 flex flex-col sm:flex-row gap-2 justify-between border-b-[2px] border-[var(--color-alert)] pb-2 group-hover:text-black group-hover:border-black shrink-0 relative z-10">
                                <span className="bg-[var(--color-alert)] text-black group-hover:bg-black group-hover:text-[var(--color-alert)] px-1">MODEL: YOLOv11</span>
                                <span>[ KINETIC_THREAT ]</span>
                            </div>
                            <h3 className="text-3xl md:text-5xl font-bold text-[var(--color-data)] uppercase group-hover:text-black leading-none break-words shrink-0 relative z-10 transition-transform duration-500 origin-left">Weapon<br />Detection</h3>
                            {/* Inner detailed text only visible when expanded or on mobile */}
                            <p className="font-mono text-sm font-bold opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity duration-500 mt-2 lg:mt-0 lg:group-hover:mt-2 leading-relaxed relative border-l-[4px] border-black pl-4">
                                CLASSIFIES 87+ FIREARM TYPES IN UNDER 12MS. <br />ZERO FALSE-POSITIVE TOLERANCE PROTOCOL ACTIVE.
                            </p>
                        </div>

                        <div className="flex-1 hover:flex-[1.5] transition-all duration-500 ease-[cubic-bezier(0.25,1,0.5,1)] p-8 group-hover:pb-[35px] border-b-[2px] border-[var(--color-iron)] hover:bg-[var(--color-data)] hover:text-black cursor-crosshair group flex flex-col overflow-hidden relative">
                            <div className="font-mono text-[var(--color-data)] font-bold text-xs mb-4 flex flex-col sm:flex-row gap-2 justify-between border-b-[2px] border-[var(--color-data)] pb-2 group-hover:text-black group-hover:border-black shrink-0 relative z-10">
                                <span className="bg-[var(--color-data)] text-black px-1 group-hover:bg-black group-hover:text-[var(--color-data)]">MODEL: LOCAL_TRACKER</span>
                                <span>[ HOSTILE_KINEMATICS ]</span>
                            </div>
                            <h3 className="text-3xl md:text-5xl font-bold text-[var(--color-data)] uppercase group-hover:text-black leading-none break-words shrink-0 relative z-10 transition-transform duration-500 origin-left">Attack<br />Stances</h3>
                            {/* Inner detailed text only visible when expanded or on mobile */}
                            <p className="font-mono text-sm font-bold opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity duration-500 mt-2 lg:mt-0 lg:group-hover:mt-2 leading-relaxed relative border-l-[4px] border-black pl-4">
                                MULTI-POINT SKELETAL INFERENCE TRACKS HOSTILE WIND-UP, <br />LUNGES, AND AGGRESSIVE VECTOR APPROACHES.
                            </p>
                        </div>

                        <div className="flex-1 hover:flex-[1.5] transition-all duration-500 ease-[cubic-bezier(0.25,1,0.5,1)] p-8 group-hover:pb-[35px] hover:bg-[var(--color-data)] hover:text-black cursor-crosshair group flex flex-col bg-[var(--color-dim)] hover:bg-[var(--color-data)] overflow-hidden relative">
                            <div className="font-mono text-[var(--color-silica)] font-bold text-xs mb-4 flex flex-col sm:flex-row gap-2 justify-between border-b-[2px] border-[var(--color-silica)] pb-2 group-hover:text-black group-hover:border-black shrink-0 relative z-10">
                                <span className="bg-[var(--color-silica)] text-black px-1 group-hover:bg-black group-hover:text-[var(--color-data)]">MODEL: LOCAL_TRACKER</span>
                                <span>[ BIOMETRIC_EVENT ]</span>
                            </div>
                            <h3 className="text-3xl md:text-5xl font-bold text-[var(--color-silica)] uppercase group-hover:text-black leading-none break-words shrink-0 relative z-10 transition-transform duration-500 origin-left">Medical<br />Emergencies</h3>
                            {/* Inner detailed text only visible when expanded or on mobile */}
                            <p className="font-mono text-sm font-bold opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity duration-500 mt-2 lg:mt-0 lg:group-hover:mt-2 leading-relaxed relative border-l-[4px] border-black pl-4">
                                SUDDEN COLLAPSE DETECTION, ERRATIC GAIT ANALYSIS, <br />AND PROLONGED IMMOBILITY TRIGGERS.
                            </p>
                        </div>
                    </div>

                    {/* Right Grid: Global Threat Map filling out the layout */}
                    <div className="lg:w-1/2 flex flex-col h-full bg-[var(--color-dim)] overflow-hidden">
                        <USThreatMap />
                    </div>
                </section>

                {/* BUILD: CORE CAPABILITIES (MVP) */}
                <section className="gsap-reveal border-b-[2px] border-[var(--color-iron)] bg-[var(--color-void)] text-[var(--color-data)] relative overflow-hidden">
                    <div className="p-8 md:p-16 border-b-[2px] border-[var(--color-iron)] bg-[var(--color-dim)] relative">
                        <div className="absolute top-0 right-0 w-64 h-64 bg-[var(--color-data)] opacity-5 rounded-full blur-3xl pointer-events-none"></div>
                        <div className="font-mono text-xs font-bold mb-4 flex items-center gap-4 text-[var(--color-silica)]">
                            <span className="w-2 h-2 bg-[var(--color-alert)] inline-block animate-ping"></span>
                            [ OVERRIDE_PROTOCOL: MVP_CAPABILITIES ]
                        </div>
                        <h2 className="text-5xl md:text-8xl lg:text-[7rem] font-black uppercase tracking-tighter leading-[0.85] mb-4 text-white mix-blend-difference z-10 relative break-words">
                            THE CORE<br />CAPABILITIES
                        </h2>
                        <p className="max-w-xl font-mono text-sm leading-relaxed border-l-2 border-[var(--color-alert)] pl-4 text-[var(--color-silica)] z-10 relative">
                            ARCHITECTURAL PRIMITIVES DESIGNED FOR THE INITIAL HACKATHON BUILD. IMMEDIATE VALUE EXTRACTION FROM EXISTING SURVEILLANCE INFRASTRUCTURE.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3">
                        {/* Capability 1 */}
                        <div className="p-8 md:p-12 border-b-[2px] md:border-b-0 md:border-r-[2px] border-[var(--color-iron)] hover:bg-[var(--color-alert)] hover:text-black transition-none cursor-crosshair group flex flex-col relative overflow-hidden bg-[var(--color-void)]">
                            <div className="font-mono text-[var(--color-alert)] group-hover:text-black font-bold text-[10px] mb-8 border-b-[2px] border-current pb-2 flex justify-between z-10 relative">
                                <span>CAPABILITY_01</span>
                                <span>[ LOCK_AND_TRACK ]</span>
                            </div>
                            <h3 className="text-4xl lg:text-5xl font-black uppercase tracking-tighter mb-4 z-10 relative group-hover:scale-105 origin-left transition-transform duration-300">
                                Weapon<br />Detection
                            </h3>
                            <p className="font-mono text-xs leading-relaxed z-10 relative opacity-80 group-hover:opacity-100 group-hover:font-bold">
                                Uses a YOLOv11 object detection model (with BoT-SORT tracking) to identify guns and knives in real-time, maintaining a lock even through motion blur.
                            </p>
                        </div>

                        {/* Capability 2 */}
                        <div className="p-8 md:p-12 border-b-[2px] md:border-b-0 md:border-r-[2px] border-[var(--color-iron)] hover:bg-[var(--color-data)] hover:text-black transition-none cursor-crosshair group flex flex-col relative overflow-hidden bg-[var(--color-void)]">
                            <div className="font-mono text-[var(--color-data)] group-hover:text-black font-bold text-[10px] mb-8 border-b-[2px] border-current pb-2 flex justify-between z-10 relative">
                                <span>CAPABILITY_02</span>
                                <span>[ BEHAVIORAL_INFERENCE ]</span>
                            </div>
                            <h3 className="text-4xl lg:text-5xl font-black uppercase tracking-tighter mb-4 z-10 relative group-hover:scale-105 origin-left transition-transform duration-300">
                                Action / Anomaly
                            </h3>
                            <p className="font-mono text-xs leading-relaxed z-10 relative opacity-80 group-hover:opacity-100 group-hover:font-bold">
                                Uses an action-recognition model (like MediaPipe or a 3D CNN) to identify aggressive motions (fights) or sudden vertical-to-horizontal drops (falls).
                            </p>
                        </div>

                        {/* Capability 3 */}
                        <div className="p-8 md:p-12 hover:bg-white hover:text-black transition-none cursor-crosshair group flex flex-col relative overflow-hidden bg-[var(--color-void)] text-[var(--color-silica)]">
                            <div className="font-mono text-[var(--color-silica)] group-hover:text-black font-bold text-[10px] mb-8 border-b-[2px] border-current pb-2 flex justify-between z-10 relative">
                                <span>CAPABILITY_03</span>
                                <span>[ STREAM_OR_STATIC ]</span>
                            </div>
                            <h3 className="text-4xl lg:text-5xl font-black uppercase tracking-tighter mb-4 z-10 relative group-hover:scale-105 origin-left transition-transform duration-300">
                                Live & VOD<br />Support
                            </h3>
                            <p className="font-mono text-xs leading-relaxed z-10 relative opacity-80 group-hover:opacity-100 group-hover:font-bold">
                                A dashboard where users can either paste a live stream link or upload an .mp4 file for immediate scanning. Universal ingestion protocol.
                            </p>
                        </div>
                    </div>
                </section>

                {/* TECH STACK & INTEGRATION */}
                <section className="border-b-[2px] border-[var(--color-iron)] bg-[var(--color-dim)] text-[var(--color-silica)] relative">
                    <div className="absolute top-0 bottom-0 left-1/2 w-[2px] bg-[var(--color-iron)] hidden lg:block"></div>
                    <div className="grid grid-cols-1 lg:grid-cols-2">
                        {/* Title Side */}
                        <div className="p-8 md:p-16 flex flex-col justify-center relative border-b-[2px] lg:border-b-0 border-[var(--color-iron)]">
                            <div className="font-mono bg-[var(--color-data)] text-black px-4 py-2 font-bold inline-block mb-8 self-start text-xs border-[1px] border-[var(--color-iron)] shadow-[4px_4px_0px_var(--color-iron)]">
                                THE ARCHITECTURE // 4.0
                            </div>
                            <h2 className="text-5xl md:text-7xl font-black uppercase tracking-tighter leading-[0.85] mb-8 text-white">
                                TECHNICAL STACK <br />
                                <span className="text-transparent bg-clip-text bg-gradient-to-r from-[var(--color-alert)] to-[var(--color-data)]">
                                    & INTEGRATIONS
                                </span>
                            </h2>
                            <div className="w-full h-64 sm:h-48 border-[2px] border-[var(--color-iron)] bg-[var(--color-void)] relative p-4 flex flex-col justify-between overflow-hidden group hover:border-[var(--color-data)] transition-colors cursor-crosshair">
                                <div className="absolute inset-0 bg-[linear-gradient(rgba(51,51,51,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(51,51,51,0.5)_1px,transparent_1px)] bg-[size:16px_16px] pointer-events-none opacity-20 group-hover:opacity-50 transition-opacity" />
                                <div className="font-mono text-[10px] text-[var(--color-data)] flex justify-between z-10 w-full mb-2">
                                    <span>[ SYSTEM SCHEMATIC ]</span>
                                    <span className="animate-pulse">ONLINE</span>
                                </div>
                                <svg viewBox="0 0 580 220" className="w-full h-full z-10 drop-shadow-[0_0_8px_rgba(255,255,255,0.2)] overflow-visible">
                                    {/* Camera → splits to two models */}
                                    <path d="M 75,50 L 95,50 L 95,20 L 120,20" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />
                                    <path d="M 75,50 L 95,50 L 95,90 L 120,90" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />
                                    {/* Audio → Qwen2 */}
                                    <path d="M 75,170 L 120,170" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />

                                    {/* Models → merge into DB */}
                                    <path d="M 230,20 L 255,20 L 255,80 L 280,80" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />
                                    <path d="M 230,90 L 280,90" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />
                                    <path d="M 230,170 L 255,170 L 255,100 L 280,100" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />

                                    {/* DB → CHAT_UI & SUPERMEMORY */}
                                    <path d="M 370,90 L 390,90 L 390,120 L 410,120" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />
                                    <path d="M 370,90 L 390,90 L 390,40 L 410,40" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />

                                    {/* SUPERMEMORY → CHAT_UI (vertical) */}
                                    <path d="M 465,60 L 465,100" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />

                                    {/* CAMERA */}
                                    <rect x="0" y="30" width="75" height="40" fill="rgba(255,255,255,0.05)" stroke="white" strokeWidth="2" />
                                    <text x="8" y="54" fill="white" fontSize="11" fontFamily="monospace" fontWeight="bold">CAMERA</text>

                                    {/* AUDIO */}
                                    <rect x="0" y="150" width="75" height="40" fill="rgba(255,255,255,0.05)" stroke="white" strokeWidth="2" />
                                    <text x="12" y="174" fill="white" fontSize="11" fontFamily="monospace" fontWeight="bold">AUDIO</text>

                                    {/* YOLOv11 */}
                                    <rect x="120" y="0" width="110" height="40" fill="rgba(255,51,0,0.1)" stroke="var(--color-alert)" strokeWidth="2" />
                                    <text x="130" y="24" fill="var(--color-alert)" fontSize="11" fontFamily="monospace" fontWeight="bold">YOLOv11</text>

                                    {/* BEHAVIOR_AI */}
                                    <rect x="120" y="70" width="110" height="40" fill="rgba(255,51,0,0.1)" stroke="var(--color-alert)" strokeWidth="2" />
                                    <text x="127" y="94" fill="var(--color-alert)" fontSize="10" fontFamily="monospace" fontWeight="bold">BEHAVIOR_AI</text>

                                    {/* QWEN2 */}
                                    <rect x="120" y="150" width="110" height="40" fill="rgba(255,51,0,0.1)" stroke="var(--color-alert)" strokeWidth="2" />
                                    <text x="142" y="174" fill="var(--color-alert)" fontSize="11" fontFamily="monospace" fontWeight="bold">QWEN2</text>

                                    {/* FBASE_DB */}
                                    <rect x="280" y="70" width="90" height="40" fill="rgba(255,255,255,0.05)" stroke="white" strokeWidth="2" />
                                    <text x="288" y="94" fill="white" fontSize="10" fontFamily="monospace" fontWeight="bold">FBASE_DB</text>

                                    {/* SUPERMEMORY */}
                                    <rect x="410" y="20" width="110" height="40" fill="rgba(0,255,102,0.05)" stroke="var(--color-data)" strokeWidth="2" />
                                    <text x="415" y="44" fill="var(--color-data)" fontSize="10" fontFamily="monospace" fontWeight="bold">SUPERMEMORY</text>

                                    {/* CHAT_UI */}
                                    <rect x="410" y="100" width="110" height="40" fill="rgba(0,255,102,0.05)" stroke="var(--color-data)" strokeWidth="2" />
                                    <text x="427" y="124" fill="var(--color-data)" fontSize="11" fontFamily="monospace" fontWeight="bold">CHAT_UI</text>
                                </svg>
                                <style>{`@keyframes dash { to { stroke-dashoffset: -16; } }`}</style>
                            </div>
                        </div>

                        {/* Content Side — Unique Artistic Brutalist Panels */}
                        <div className="flex flex-col gsap-stagger-parent">
                            {/* GPU Terminal Panel — inverted with glitch scanlines */}
                            <div className="gsap-stagger-child flex-1 border-b-[2px] border-[var(--color-iron)] relative overflow-hidden group cursor-crosshair">
                                <div className="absolute inset-0 bg-[var(--color-alert)] opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-0" />
                                <div className="absolute inset-0 bg-[linear-gradient(transparent_50%,rgba(0,0,0,0.3)_50%)] bg-[size:100%_4px] pointer-events-none z-10 opacity-30" />
                                <div className="relative z-20 p-6 md:p-8 flex flex-col justify-between h-full">
                                    <div className="flex justify-between items-start">
                                        <div className="font-mono text-[10px] text-[var(--color-alert)] group-hover:text-black font-bold border-b border-[var(--color-alert)] group-hover:border-black pb-1 mb-4">// MODULE_GPU_INFERENCE</div>
                                        <div className="font-black text-5xl md:text-7xl opacity-[0.04] group-hover:opacity-10 font-mono leading-none">01</div>
                                    </div>
                                    <div>
                                        <h3 className="text-xl md:text-2xl font-black uppercase tracking-tighter mb-3 text-[var(--color-data)] group-hover:text-black">Serverless GPU Inference</h3>
                                        <p className="font-mono text-xs leading-relaxed text-[var(--color-silica)] group-hover:text-black/80 max-w-sm">YOLO + action-recognition on Modal's serverless GPUs. 15+ FPS real-time. Zero local bottlenecks.</p>
                                    </div>
                                </div>
                            </div>

                            {/* Supermemory — data-counter strip with horizontal metric bars */}
                            <div className="gsap-stagger-child flex-1 border-b-[2px] border-[var(--color-iron)] relative overflow-hidden group cursor-crosshair bg-[var(--color-dim)]">
                                <div className="relative z-20 p-6 md:p-8 flex flex-col justify-between h-full">
                                    <div className="flex justify-between items-start">
                                        <div className="font-mono text-[10px] text-[var(--color-data)] font-bold border-b border-[var(--color-data)] pb-1 mb-4">// MODULE_VECTOR_RECALL</div>
                                        <div className="font-black text-5xl md:text-7xl opacity-[0.04] font-mono leading-none">02</div>
                                    </div>
                                    <div className="flex flex-col gap-3">
                                        <h3 className="text-xl md:text-2xl font-black uppercase tracking-tighter text-[var(--color-data)] group-hover:text-[var(--color-alert)]">Semantic Recall Engine</h3>
                                        {/* Metric bars — visual data representation */}
                                        <div className="flex flex-col gap-1.5 mt-2">
                                            <div className="flex items-center gap-3 font-mono text-[10px] text-[var(--color-silica)]">
                                                <span className="w-20 shrink-0">RECALL</span>
                                                <div className="flex-1 h-2 bg-[var(--color-iron)] relative overflow-hidden"><div className="absolute inset-y-0 left-0 w-[94%] bg-[var(--color-data)] group-hover:bg-[var(--color-alert)] transition-colors" /></div>
                                                <span className="w-8 text-right">94%</span>
                                            </div>
                                            <div className="flex items-center gap-3 font-mono text-[10px] text-[var(--color-silica)]">
                                                <span className="w-20 shrink-0">LATENCY</span>
                                                <div className="flex-1 h-2 bg-[var(--color-iron)] relative overflow-hidden"><div className="absolute inset-y-0 left-0 w-[12%] bg-[var(--color-alert)]" /></div>
                                                <span className="w-8 text-right">8ms</span>
                                            </div>
                                            <div className="flex items-center gap-3 font-mono text-[10px] text-[var(--color-silica)]">
                                                <span className="w-20 shrink-0">CORPUS</span>
                                                <div className="flex-1 h-2 bg-[var(--color-iron)] relative overflow-hidden"><div className="absolute inset-y-0 left-0 w-[67%] bg-[var(--color-data)] group-hover:bg-white transition-colors" /></div>
                                                <span className="w-8 text-right">∞</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Deployment — asymmetric split with big number + marquee */}
                            <div className="gsap-stagger-child flex-1 relative overflow-hidden group cursor-crosshair">
                                <div className="absolute inset-0 bg-[var(--color-data)] opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-0" />
                                <div className="relative z-20 p-6 md:p-8 flex flex-col justify-between h-full">
                                    <div className="flex justify-between items-start">
                                        <div className="font-mono text-[10px] text-[var(--color-silica)] group-hover:text-black font-bold border-b border-[var(--color-iron)] group-hover:border-black pb-1 mb-4">// MODULE_EDGE_DEPLOY</div>
                                        <div className="font-black text-5xl md:text-7xl opacity-[0.04] group-hover:opacity-10 font-mono leading-none">03</div>
                                    </div>
                                    <div className="flex items-end gap-4">
                                        <div className="gsap-counter text-4xl md:text-6xl font-black text-[var(--color-alert)] group-hover:text-black leading-none">99.9<span className="text-lg">%</span></div>
                                        <div className="flex-1 pb-1">
                                            <h3 className="text-lg font-black uppercase tracking-tighter text-[var(--color-data)] group-hover:text-black mb-1">Global Edge</h3>
                                            <p className="font-mono text-[10px] text-[var(--color-silica)] group-hover:text-black/70">DigitalOcean App Platform / .TECH domain. Resilient CDN delivery for critical response.</p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

            </main>

            <footer className="py-2 px-8 flex justify-between items-center font-mono text-[10px] text-[var(--color-silica)] bg-[var(--color-void)] border-t-[2px] border-[var(--color-iron)] mt-auto relative z-10 font-bold bg-[#000] pb-20 sm:pb-2">
                <span>EOF. © {new Date().getFullYear()} AKAWA_DEV // ALL PROTOCOLS RESERVED</span>
                <span className="hidden sm:inline-block bg-[var(--color-iron)] text-white px-1">RENDER_ID: {renderId}</span>
            </footer>

            {/* STICKY MOBILE CTA */}
            <div className="fixed bottom-0 left-0 right-0 z-[60] p-4 bg-gradient-to-t from-black to-transparent sm:hidden">
                <Link href="/signup" className="btn-alert w-full py-4 text-center block text-sm shadow-[0_0_20px_rgba(255,51,0,0.3)]">
                    [ INITIALIZE_SYSTEM_ACCESS ]
                </Link>
            </div>
        </div>
    );
}
