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
        <span className={`inline-block relative whitespace-nowrap ${className}`}>
            <span className="opacity-0 pointer-events-none select-none">{text}</span>
            <span className="absolute top-0 left-0 bottom-0 whitespace-nowrap font-mono">{displayText || " "}</span>
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
const US_OUTLINE_PATH = "M 161,489 L 152,492 148,503 143,506 139,504 134,509 133,536 132,540 122,548 119,556 113,556 104,559 94,557 84,552 82,559 84,575 92,593 108,593 208,597 226,597 244,597 253,590 259,580 274,579 289,578 322,577 332,571 334,529 342,509 362,492 386,472 408,449 410,427 424,413 428,398 468,367 480,365 487,351 497,345 505,349 507,357 516,366 527,370 548,366 563,356 570,352 574,355 610,338 626,332 646,332 650,306 650,278 666,258 684,240 698,230 706,220 722,210 729,202 733,188 744,174 750,168 755,156 758,156 762,148 766,138 776,128 789,120 795,115 801,112 808,120 815,122 824,110 839,92 848,76 856,64 864,58 872,62 878,64 884,68 893,80 905,90 939,100 958,112 960,120 951,134 939,150 930,161 924,180 920,200 918,218 920,228 920,240 918,250 918,272 915,290 893,298 880,308 874,320 864,334 854,350 846,360 841,372 838,392 844,410 850,424 848,440 844,452 837,470 828,486 824,504 819,524 813,538 805,550 796,554 784,548 776,550 770,559 763,556 758,545 757,539 755,535 744,532 742,528 738,522 723,525 718,528 714,536 706,544 700,548 694,546 688,549 680,555 673,560 672,564 668,577 L 656,586 648,584 638,586 628,580 618,566 610,564 600,568 593,575 583,582 575,588 568,587 558,582 547,584 543,595 530,597 510,597 502,593 497,593 487,599 476,597 465,599 455,597 446,599 438,597 420,597 408,597 396,597 378,597 368,597 354,597 340,597 322,597 307,597 292,597 274,597 258,597 240,597 225,597 208,597 190,597 174,597 163,597 161,597 Z";

// Node positions calibrated for the 960x600 viewBox US outline
const THREAT_NODES = [
    { cx: 200, cy: 440, name: "NODE_LAX" },
    { cx: 170, cy: 360, name: "NODE_SFO" },
    { cx: 225, cy: 210, name: "NODE_SEA" },
    { cx: 340, cy: 440, name: "NODE_PHX" },
    { cx: 450, cy: 340, name: "NODE_DEN" },
    { cx: 580, cy: 470, name: "NODE_DFW" },
    { cx: 650, cy: 290, name: "NODE_ORD" },
    { cx: 830, cy: 200, name: "NODE_JFK" },
    { cx: 800, cy: 280, name: "NODE_DCA" },
    { cx: 780, cy: 530, name: "NODE_MIA" },
    { cx: 600, cy: 520, name: "NODE_IAH" },
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
        <div className="w-full flex flex-col pt-8 lg:p-12 lg:pl-0 h-full border-b-[2px] lg:border-b-0 border-[var(--color-iron)]">
            <div className="flex justify-between w-full font-mono text-xs text-[var(--color-silica)] border-b-[2px] border-[var(--color-iron)] pb-2 mb-8 uppercase font-bold px-8 lg:px-0">
                <span>[ GLOBAL_THREAT_MATRIX ]</span>
                <span className="text-[var(--color-alert)] animate-pulse hidden sm:inline-block">ACTIVE_NODE_SYNDICATION</span>
            </div>

            <div className="flex-1 flex items-center justify-center relative w-full px-4 sm:px-8 lg:px-0 py-8 mix-blend-screen opacity-80 min-h-[250px] sm:min-h-[300px]">
                <svg viewBox="80 50 900 560" className="w-full h-full drop-shadow-[0_0_15px_rgba(255,255,255,0.1)] overflow-visible" preserveAspectRatio="xMidYMid meet">
                    {/* Grid lines */}
                    <path d="M200,50 V610 M400,50 V610 M600,50 V610 M800,50 V610 M80,200 H980 M80,400 H980" stroke="rgba(255,255,255,0.03)" strokeWidth="1" strokeDasharray="8,8" />

                    {/* Accurate US Contiguous Outline */}
                    <path
                        d={US_OUTLINE_PATH}
                        fill="rgba(255,255,255,0.015)"
                        stroke="var(--color-iron)"
                        strokeWidth="2"
                        strokeLinejoin="round"
                    />

                    {/* Targeting Crosshairs at center */}
                    <line x1="530" y1="360" x2="530" y2="400" stroke="var(--color-alert)" strokeWidth="1" opacity="0.3" />
                    <line x1="510" y1="380" x2="550" y2="380" stroke="var(--color-alert)" strokeWidth="1" opacity="0.3" />
                    <circle cx="530" cy="380" r="30" fill="none" stroke="var(--color-iron)" strokeWidth="1" strokeDasharray="4 4" opacity="0.4" />

                    {/* Threat Nodes — all aligned around (cx, cy) */}
                    {THREAT_NODES.map((node, i) => {
                        const isActive = activeNodes.includes(i);
                        return (
                            <g key={i}>
                                {isActive && (
                                    <>
                                        <circle cx={node.cx} cy={node.cy} r="28" fill="var(--color-alert)" opacity="0.08" className="animate-ping" />
                                        <circle cx={node.cx} cy={node.cy} r="16" fill="none" stroke="var(--color-alert)" strokeWidth="1" opacity="0.35" />
                                    </>
                                )}
                                <circle
                                    cx={node.cx}
                                    cy={node.cy}
                                    r={isActive ? 5 : 2.5}
                                    fill={isActive ? "var(--color-alert)" : "var(--color-iron)"}
                                />
                                {isActive && (
                                    <>
                                        <line x1={node.cx} y1={node.cy} x2={node.cx + 30} y2={node.cy - 25} stroke="var(--color-alert)" strokeWidth="1" opacity="0.5" />
                                        <text x={node.cx + 33} y={node.cy - 22} fill="var(--color-alert)" fontSize="11" fontFamily="monospace" fontWeight="bold">
                                            [{node.name}]
                                        </text>
                                    </>
                                )}
                            </g>
                        );
                    })}
                </svg>
            </div>

            <div className="flex justify-between w-full font-mono text-[10px] text-[var(--color-iron)] border-t-[2px] border-[var(--color-iron)] pt-2 mt-8 px-8 lg:px-0 font-bold">
                <span>TOPOLOGY: AEGIS_US_MAINNET</span>
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

    const [renderId] = useState(() => Math.random().toString(36).substring(7).toUpperCase());

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
                        <span className="font-mono">AEGIS_OS</span>
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

                        <div className="relative z-10 mix-blend-difference">
                            <h1 className="text-[3.5rem] sm:text-7xl md:text-8xl lg:text-[7rem] xl:text-[9rem] font-bold leading-[0.9] mb-8 text-[var(--color-data)] tracking-tighter whitespace-nowrap overflow-visible">
                                <ScrambleText text="ABSOLUTE" delay={500} /><br />
                                <span className="text-[var(--color-alert)] mix-blend-screen"><ScrambleText text="VIGILANCE" delay={1000} /></span><span className="text-[var(--color-alert)] animate-pulse">_</span>
                            </h1>

                            <div className="max-w-2xl font-mono text-sm leading-relaxed text-[var(--color-silica)] mb-12 border-l-[4px] border-[var(--color-alert)] pl-4 bg-[var(--color-void)] p-4 border-y border-r border-[#333]">
                                <p className="mb-4 text-[var(--color-alert)] font-bold">// TWO-STAGE ARCHITECTURE:</p>
                                <p>
                                    TRANSFORM PASSIVE CAMPUS HARDWARE INTO AN UNBLINKING PROACTIVE DEFENSE GRID. <span className="text-white font-bold bg-[#333] px-1">YOLOv11</span> FOR RAPID WEAPON CLASSIFICATION. <span className="text-white font-bold bg-[#333] px-1">BEHAVIORAL AI</span> FOR KINEMATIC STANCE TRACKING.
                                </p>
                            </div>

                            <div className="flex flex-col sm:flex-row gap-0">
                                <Link href="/signup" className="btn-alert text-xl md:text-2xl py-6 px-8 flex-1 text-center font-bold">
                                    [ DEPLOY_INSTANCE ]
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

                    <div className="aspect-[21/9] min-h-[300px] md:min-h-[500px] w-full bg-[#050505] relative overflow-hidden flex items-center justify-center p-8">
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
                                <span>UTC: {new Date().toISOString().substring(0, 19).replace('T', ' ')}</span>
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

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-16">
                            <div className="border-l-4 border-black pl-6 bg-[var(--color-alert)]/90 p-4 hover:bg-black hover:text-[var(--color-alert)] transition-none cursor-crosshair group">
                                <h3 className="text-5xl md:text-7xl font-black mb-2 group-hover:animate-none animate-pulse">99%</h3>
                                <p className="font-mono font-bold text-sm md:text-base leading-tight">OF TRADITIONAL CCTV FOOTAGE IS NEVER WATCHED LIVE. CAMERAS ONLY RECORD HISTORY.</p>
                            </div>
                            <div className="border-l-4 border-black pl-6 bg-[var(--color-alert)]/90 p-4 hover:bg-black hover:text-[var(--color-alert)] transition-none cursor-crosshair">
                                <h3 className="text-5xl md:text-7xl font-black mb-2">ZERO</h3>
                                <p className="font-mono font-bold text-sm md:text-base leading-tight">PREEMPTIVE ACTION TAKEN BEFORE THE THRESHOLD. REACTIVE SURVEILLANCE ONLY DOCUMENTS THE AFTERMATH.</p>
                            </div>
                            <div className="border-l-4 border-black pl-6 bg-[var(--color-alert)]/90 p-4 hover:bg-black hover:text-[var(--color-alert)] transition-none cursor-crosshair">
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
                            <h2 className="text-5xl md:text-6xl lg:text-7xl font-black tracking-tighter leading-none mb-6">OPERATIONAL<br />AXIOMS</h2>
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
                                <h3 className="text-3xl md:text-5xl font-black tracking-tighter mb-2 uppercase">Preemption Over Reaction</h3>
                            </div>

                            <div
                                style={{ clipPath: axiomInView ? 'polygon(0 0, 100% 0, 100% 100%, 0 100%)' : 'polygon(0 0, 0 0, 0 100%, 0% 100%)', transition: 'clip-path 0.2s linear 0.1s' }}
                                className="flex-1 p-8 md:p-12 border-b-[2px] border-[var(--color-iron)] hover:bg-[var(--color-void)] hover:text-[var(--color-data)] cursor-crosshair flex flex-col justify-center"
                            >
                                <div className="font-mono font-bold text-xs mb-4">AXIOM_02</div>
                                <h3 className="text-3xl md:text-5xl font-black tracking-tighter mb-2 uppercase">Machine Tirelessness</h3>
                            </div>

                            <div
                                style={{ clipPath: axiomInView ? 'polygon(0 0, 100% 0, 100% 100%, 0 100%)' : 'polygon(0 0, 0 0, 0 100%, 0% 100%)', transition: 'clip-path 0.2s linear 0.2s' }}
                                className="flex-1 p-8 md:p-12 hover:bg-[var(--color-void)] hover:text-[var(--color-data)] group cursor-crosshair flex flex-col justify-center"
                            >
                                <div className="font-mono font-bold text-xs mb-4">AXIOM_03</div>
                                <h3 className="text-3xl md:text-5xl font-black tracking-tighter mb-2 uppercase text-[var(--color-alert)] group-hover:text-[var(--color-alert)]">Zero Grace Period</h3>
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
                        <div className="flex-1 hover:flex-[2] transition-all duration-500 ease-[cubic-bezier(0.25,1,0.5,1)] p-8 border-b-[2px] border-[var(--color-iron)] hover:bg-[var(--color-alert)] hover:text-black cursor-crosshair group flex flex-col overflow-hidden relative">
                            <div className="font-mono text-[var(--color-alert)] font-bold text-xs mb-4 flex flex-col sm:flex-row gap-2 justify-between border-b-[2px] border-[var(--color-alert)] pb-2 group-hover:text-black group-hover:border-black shrink-0 relative z-10">
                                <span className="bg-[var(--color-alert)] text-black group-hover:bg-black group-hover:text-[var(--color-alert)] px-1">MODEL: YOLOv11</span>
                                <span>[ KINETIC_THREAT ]</span>
                            </div>
                            <h3 className="text-3xl md:text-5xl font-bold text-[var(--color-data)] uppercase group-hover:text-black leading-none break-words shrink-0 relative z-10 transition-transform duration-500 origin-left">Weapon<br />Detection</h3>
                            {/* Inner detailed text only visible when expanded */}
                            <p className="font-mono text-sm font-bold opacity-0 group-hover:opacity-100 transition-opacity duration-500 mt-4 leading-relaxed absolute bottom-4 border-l-[4px] border-black pl-4">
                                CLASSIFIES 87+ FIREARM TYPES IN UNDER 12MS. <br />ZERO FALSE-POSITIVE TOLERANCE PROTOCOL ACTIVE.
                            </p>
                        </div>

                        <div className="flex-1 hover:flex-[2] transition-all duration-500 ease-[cubic-bezier(0.25,1,0.5,1)] p-8 border-b-[2px] border-[var(--color-iron)] hover:bg-[var(--color-data)] hover:text-black cursor-crosshair group flex flex-col overflow-hidden relative">
                            <div className="font-mono text-[var(--color-data)] font-bold text-xs mb-4 flex flex-col sm:flex-row gap-2 justify-between border-b-[2px] border-[var(--color-data)] pb-2 group-hover:text-black group-hover:border-black shrink-0 relative z-10">
                                <span className="bg-[var(--color-data)] text-black px-1 group-hover:bg-black group-hover:text-[var(--color-data)]">MODEL: LOCAL_TRACKER</span>
                                <span>[ HOSTILE_KINEMATICS ]</span>
                            </div>
                            <h3 className="text-3xl md:text-5xl font-bold text-[var(--color-data)] uppercase group-hover:text-black leading-none break-words shrink-0 relative z-10 transition-transform duration-500 origin-left">Attack<br />Stances</h3>
                            {/* Inner detailed text only visible when expanded */}
                            <p className="font-mono text-sm font-bold opacity-0 group-hover:opacity-100 transition-opacity duration-500 mt-4 leading-relaxed absolute bottom-4 border-l-[4px] border-black pl-4">
                                MULTI-POINT SKELETAL INFERENCE TRACKS HOSTILE WIND-UP, <br />LUNGES, AND AGGRESSIVE VECTOR APPROACHES.
                            </p>
                        </div>

                        <div className="flex-1 hover:flex-[2] transition-all duration-500 ease-[cubic-bezier(0.25,1,0.5,1)] p-8 hover:bg-[var(--color-data)] hover:text-black cursor-crosshair group flex flex-col bg-[var(--color-dim)] hover:bg-[var(--color-data)] overflow-hidden relative">
                            <div className="font-mono text-[var(--color-silica)] font-bold text-xs mb-4 flex flex-col sm:flex-row gap-2 justify-between border-b-[2px] border-[var(--color-silica)] pb-2 group-hover:text-black group-hover:border-black shrink-0 relative z-10">
                                <span className="bg-[var(--color-silica)] text-black px-1 group-hover:bg-black group-hover:text-[var(--color-data)]">MODEL: LOCAL_TRACKER</span>
                                <span>[ BIOMETRIC_EVENT ]</span>
                            </div>
                            <h3 className="text-3xl md:text-5xl font-bold text-[var(--color-silica)] uppercase group-hover:text-black leading-none break-words shrink-0 relative z-10 transition-transform duration-500 origin-left">Medical<br />Emergencies</h3>
                            {/* Inner detailed text only visible when expanded */}
                            <p className="font-mono text-sm font-bold opacity-0 group-hover:opacity-100 transition-opacity duration-500 mt-4 leading-relaxed absolute bottom-4 border-l-[4px] border-black pl-4">
                                SUDDEN COLLAPSE DETECTION, ERRATIC GAIT ANALYSIS, <br />AND PROLONGED IMMOBILITY TRIGGERS.
                            </p>
                        </div>
                    </div>

                    {/* Right Grid: Global Threat Map filling out the layout */}
                    <div className="lg:w-1/2 flex flex-col h-full bg-[var(--color-dim)] overflow-hidden">
                        <USThreatMap />
                        <div className="p-8 flex-1 flex flex-col justify-end text-[var(--color-silica)] font-mono text-xs leading-relaxed max-w-md bg-[var(--color-void)] z-10">
                            <p className="border-l-[2px] border-[var(--color-alert)] pl-4 backdrop-blur-md">
                                THE ARCHITECTURE ABSTRACTS GLOBAL INFRASTRUCTURE INTO A SINGULAR CONSTRUCT. CAMERA ENDPOINTS ARE NO LONGER PASSIVE SENSORS; THEY ARE <span className="text-white">COMPUTATIONAL PROXIES</span> SECURING PHYSICAL SPACE AT SUBLIMINAL SPEEDS.
                            </p>
                        </div>
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
                                Uses a YOLOv8 object detection model (with BoT-SORT tracking) to identify guns and knives in real-time, maintaining a lock even through motion blur.
                            </p>
                            <div className="absolute -bottom-16 -right-16 text-[10rem] font-black tracking-tighter opacity-5 group-hover:opacity-20 transition-opacity z-0 pointer-events-none">
                                01
                            </div>
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
                            <div className="absolute -bottom-16 -right-16 text-[10rem] font-black tracking-tighter opacity-5 group-hover:opacity-20 transition-opacity z-0 pointer-events-none">
                                02
                            </div>
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
                            <div className="absolute -bottom-16 -right-16 text-[10rem] font-black tracking-tighter opacity-5 group-hover:opacity-20 transition-opacity z-0 pointer-events-none">
                                03
                            </div>
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
                            <div className="w-full h-48 border-[2px] border-[var(--color-iron)] bg-[var(--color-void)] relative p-4 flex flex-col justify-between overflow-hidden group hover:border-[var(--color-data)] transition-colors cursor-crosshair">
                                <div className="absolute inset-0 bg-[linear-gradient(rgba(51,51,51,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(51,51,51,0.5)_1px,transparent_1px)] bg-[size:16px_16px] pointer-events-none opacity-20 group-hover:opacity-50 transition-opacity" />
                                <div className="font-mono text-[10px] text-[var(--color-data)] flex justify-between z-10 w-full mb-2">
                                    <span>[ SYSTEM SCHEMATIC ]</span>
                                    <span className="animate-pulse">ONLINE</span>
                                </div>
                                <svg viewBox="0 0 580 170" className="w-full h-full z-10 drop-shadow-[0_0_8px_rgba(255,255,255,0.2)] overflow-visible">
                                    {/* Camera → splits to two models */}
                                    <path d="M 75,80 L 95,80 L 95,50 L 120,50" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />
                                    <path d="M 75,80 L 95,80 L 95,120 L 120,120" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />
                                    {/* Models → merge into DB */}
                                    <path d="M 230,50 L 255,50 L 255,80 L 280,80" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />
                                    <path d="M 230,120 L 255,120 L 255,80 L 280,80" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />
                                    {/* DB → CHAT_UI */}
                                    <path d="M 370,80 L 410,80" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />
                                    {/* DB → up → SUPERMEMORY */}
                                    <path d="M 325,60 L 325,30 L 410,30" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />
                                    {/* SUPERMEMORY → CHAT_UI (vertical) */}
                                    <path d="M 465,50 L 465,60" stroke="var(--color-data)" strokeWidth="2" strokeDasharray="4 4" className="animate-[dash_2s_linear_infinite]" fill="none" />

                                    {/* CAMERA */}
                                    <rect x="0" y="60" width="75" height="40" fill="rgba(255,255,255,0.05)" stroke="white" strokeWidth="2" />
                                    <text x="8" y="84" fill="white" fontSize="11" fontFamily="monospace" fontWeight="bold">CAMERA</text>

                                    {/* YOLOv11 */}
                                    <rect x="120" y="30" width="110" height="40" fill="rgba(255,51,0,0.1)" stroke="var(--color-alert)" strokeWidth="2" />
                                    <text x="130" y="55" fill="var(--color-alert)" fontSize="11" fontFamily="monospace" fontWeight="bold">YOLOv11</text>

                                    {/* BEHAVIOR_AI */}
                                    <rect x="120" y="100" width="110" height="40" fill="rgba(255,51,0,0.1)" stroke="var(--color-alert)" strokeWidth="2" />
                                    <text x="127" y="125" fill="var(--color-alert)" fontSize="10" fontFamily="monospace" fontWeight="bold">BEHAVIOR_AI</text>

                                    {/* FBASE_DB */}
                                    <rect x="280" y="60" width="90" height="40" fill="rgba(255,255,255,0.05)" stroke="white" strokeWidth="2" />
                                    <text x="288" y="84" fill="white" fontSize="10" fontFamily="monospace" fontWeight="bold">FBASE_DB</text>

                                    {/* SUPERMEMORY */}
                                    <rect x="410" y="10" width="110" height="40" fill="rgba(0,255,102,0.05)" stroke="var(--color-data)" strokeWidth="2" />
                                    <text x="415" y="35" fill="var(--color-data)" fontSize="10" fontFamily="monospace" fontWeight="bold">SUPERMEMORY</text>

                                    {/* CHAT_UI */}
                                    <rect x="410" y="60" width="110" height="40" fill="rgba(0,255,102,0.05)" stroke="var(--color-data)" strokeWidth="2" />
                                    <text x="427" y="84" fill="var(--color-data)" fontSize="11" fontFamily="monospace" fontWeight="bold">CHAT_UI</text>
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
                                        <p className="font-mono text-xs leading-relaxed text-[var(--color-silica)] group-hover:text-black/80 max-w-sm">YOLO + action-recognition on Modal's serverless GPUs. 30+ FPS real-time. Zero local bottlenecks.</p>
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

            <footer className="py-2 px-8 flex justify-between items-center font-mono text-[10px] text-[var(--color-silica)] bg-[var(--color-void)] border-t-[2px] border-[var(--color-iron)] mt-auto relative z-10 font-bold bg-[#000]">
                <span>EOF. © {new Date().getFullYear()} AIWEAPON_DEV // ALL PROTOCOLS RESERVED</span>
                <span className="hidden sm:inline-block bg-[var(--color-iron)] text-white px-1">RENDER_ID: {renderId}</span>
            </footer>
        </div>
    );
}
