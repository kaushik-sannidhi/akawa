"use client";

import { useState } from "react";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { ref, set } from "firebase/database";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";

export function BrutalistAuth({ initialView = "login" }: { initialView?: "login" | "signup" }) {
    const [view, setView] = useState<"login" | "signup" | "onboarding">(initialView as any);
    const [telegramId, setTelegramId] = useState("");
    const [email, setEmail] = useState("admin@akawa.os");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const router = useRouter();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError("");
        try {
            if (view === "login") {
                await signInWithEmailAndPassword(auth, email, password);
                setView("onboarding");
            } else if (view === "signup") {
                await createUserWithEmailAndPassword(auth, email, password);
                setView("onboarding");
            } else if (view === "onboarding") {
                const user = auth.currentUser;
                if (user) {
                    try {
                        await set(ref(db, `alerts_config/${user.uid}`), {
                            email: email,
                            telegram_id: telegramId || null,
                            enabled: true,
                            updated_at: new Date().toISOString()
                        });
                    } catch (configErr) {
                        console.error("Failed to save alert config:", configErr);
                    }
                }
                router.push("/dashboard");
            }
        } catch (err: any) {
            setError(err.message || "AUTHENTICATION_FAILED");
        } finally {
            setLoading(false);
        }
    };

    const toggleView = () => {
        if (view === "onboarding") {
            router.push("/dashboard");
            return;
        }
        setError("");
        setPassword("");
        setView(view === "login" ? "signup" : "login");
    };

    // Abstract Cybernetic Shutter Definition
    const variants = {
        enter: (direction: number) => ({
            x: direction > 0 ? 300 : -300,
            opacity: 0,
            scaleY: 0.1, // Smashed vertical
            filter: "blur(20px)",
            clipPath: direction > 0 ? "polygon(0 0, 10% 0, 10% 100%, 0 100%)" : "polygon(90% 0, 100% 0, 100% 100%, 90% 100%)",
        }),
        center: {
            zIndex: 1,
            x: 0,
            opacity: 1,
            scaleY: 1,
            filter: "blur(0px)",
            clipPath: "polygon(0 0, 100% 0, 100% 100%, 0 100%)",
        },
        exit: (direction: number) => ({
            zIndex: 0,
            x: direction < 0 ? 300 : -300,
            opacity: 0,
            scaleY: 0.1,
            filter: "blur(20px)",
            clipPath: direction < 0 ? "polygon(90% 0, 100% 0, 100% 100%, 90% 100%)" : "polygon(0 0, 10% 0, 10% 100%, 0 100%)",
        })
    };

    const swipePower = (offset: number, velocity: number) => {
        return Math.abs(offset) * velocity;
    };

    const direction = view === "login" ? -1 : 1;

    return (
        <div className="min-h-screen bg-[var(--color-void)] flex flex-col md:flex-row font-sans tracking-tight selection:bg-[var(--color-alert)] selection:text-black overflow-hidden relative">
            {/* Global Noise just for the auth background */}
            <div className="absolute inset-0 z-0 pointer-events-none opacity-20 bg-[var(--color-void)] mix-blend-screen terminal-overlay" />

            {/* Left Panel: Static Branding */}
            <div className="hidden md:flex flex-1 border-r-[2px] border-[var(--color-iron)] bg-[var(--color-dim)] relative overflow-hidden flex-col justify-between p-8 z-10">
                <div className="absolute inset-0 bg-[linear-gradient(rgba(51,51,51,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(51,51,51,0.5)_1px,transparent_1px)] bg-[size:32px_32px] opacity-20 pointer-events-none" />

                <Link href="/" className="font-mono font-bold text-2xl text-[var(--color-data)] flex items-center gap-2 relative z-10 w-fit cursor-crosshair">
                    <div className="w-4 h-4 bg-[var(--color-alert)] animate-pulse" />
                    AKAWA_OS
                </Link>

                <div className="relative z-10 mb-24">
                    <h1 className="text-6xl lg:text-8xl font-black text-white leading-[0.85] uppercase break-words mix-blend-difference mb-8">
                        {view === "login" ? "SYSTEM\nLOGIN" : view === "signup" ? "INITIALIZE\nWORKSPACE" : "MOBILE\nALERTS"}
                    </h1>
                    <div className="border-l-[4px] border-[var(--color-alert)] pl-4">
                        <p className="font-mono text-[var(--color-silica)] text-sm max-w-sm uppercase font-bold">
                            {view === "login"
                                ? "WARNING: UNAUTHORIZED ACCESS IS LOGGED AND TRACED."
                                : view === "signup"
                                    ? "DEPLOY A NEW A.I. INSTANCE TO YOUR HARDWARE ENVIRONMENT."
                                    : "OPTIONAL: LINK TELEGRAM DMs. EMAILS ARE AUTOMATIC."}
                        </p>
                    </div>
                </div>

                <div className="font-mono text-[10px] text-[var(--color-iron)] relative z-10 bg-black p-2 border border-[var(--color-iron)] w-fit break-all">
                    SESSION_ID: {Math.random().toString(36).substring(2, 15).toUpperCase()} <br />
                    UTC_SYNC: {new Date().toISOString()}
                </div>
            </div>

            {/* Right Panel: Animated Forms */}
            <div className="flex-1 flex items-center justify-center p-6 relative bg-[var(--color-void)] z-10">
                <div className="w-full max-w-md relative pb-16">
                    <AnimatePresence custom={direction} mode="wait">
                        <motion.div
                            key={view}
                            custom={direction}
                            variants={variants}
                            initial="enter"
                            animate="center"
                            exit="exit"
                            transition={{
                                x: { type: "tween", duration: 0.3, ease: "circOut" },
                                opacity: { duration: 0.15 },
                                scaleY: { type: "spring", stiffness: 400, damping: 20 },
                                filter: { duration: 0.2 },
                                clipPath: { duration: 0.3, ease: "anticipate" }
                            }}
                            className="w-full bg-black border-[2px] border-[var(--color-iron)] p-8 relative overflow-hidden animate-slide-in-bottom"
                            drag="x"
                            dragConstraints={{ left: 0, right: 0 }}
                            dragElastic={1}
                            onDragEnd={(e, { offset, velocity }) => {
                                const swipe = swipePower(offset.x, velocity.x);
                                if (swipe < -10000) {
                                    setView("signup");
                                } else if (swipe > 10000) {
                                    setView("login");
                                }
                            }}
                        >
                            {/* Decorative corner brackets */}
                            <div className="absolute top-0 left-0 w-4 h-4 border-t-[2px] border-l-[2px] border-[var(--color-data)]" />
                            <div className="absolute top-0 right-0 w-4 h-4 border-t-[2px] border-r-[2px] border-[var(--color-data)]" />
                            <div className="absolute bottom-0 left-0 w-4 h-4 border-b-[2px] border-l-[2px] border-[var(--color-data)]" />
                            <div className="absolute bottom-0 right-0 w-4 h-4 border-b-[2px] border-r-[2px] border-[var(--color-data)]" />

                            <div className="font-mono pt-2 text-[10px] text-[var(--color-silica)] border-b-[2px] border-[var(--color-iron)] pb-2 mb-8 flex justify-between items-end">
                                <span>[ SECURE_PORTAL ]</span>
                                <span className="text-[var(--color-alert)] animate-pulse uppercase">{view}</span>
                            </div>

                            {error && (
                                <div className="mb-8 p-3 bg-[var(--color-alert)] text-black font-mono text-xs font-bold uppercase animate-pulse border-2 border-[var(--color-alert)]">
                                    [ ERROR_CODE: {error} ]
                                </div>
                            )}

                            <form onSubmit={handleSubmit} className="space-y-6">
                                {view !== "onboarding" ? (
                                    <>
                                        <div className="space-y-2">
                                            <label className="block font-mono text-xs text-[var(--color-silica)] uppercase font-bold">Operator ID (Email)</label>
                                            <input
                                                type="email"
                                                required
                                                value={email}
                                                onChange={(e) => setEmail(e.target.value)}
                                                className="w-full bg-[var(--color-dim)] border-[2px] border-[var(--color-iron)] p-3 text-white font-mono text-sm focus:border-[var(--color-data)] focus:outline-none transition-colors rounded-none placeholder:text-[var(--color-iron)]"
                                                placeholder="admin@akawa.os"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="block font-mono text-xs text-[var(--color-silica)] uppercase font-bold">Access Code</label>
                                            <input
                                                type="password"
                                                required
                                                value={password}
                                                onChange={(e) => setPassword(e.target.value)}
                                                className="w-full bg-[var(--color-dim)] border-[2px] border-[var(--color-iron)] p-3 text-white font-mono tracking-widest text-lg focus:border-[var(--color-data)] focus:outline-none transition-colors rounded-none placeholder:text-[var(--color-iron)]"
                                                placeholder="••••••••"
                                            />
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="space-y-2">
                                            <label className="block font-mono text-xs text-[var(--color-silica)] uppercase font-bold">Telegram Chat ID (Optional)</label>
                                            <input
                                                type="text"
                                                value={telegramId}
                                                onChange={(e) => setTelegramId(e.target.value)}
                                                className="w-full bg-[var(--color-dim)] border-[2px] border-[var(--color-iron)] p-3 text-white font-mono text-sm focus:border-[var(--color-data)] focus:outline-none transition-colors rounded-none placeholder:text-[var(--color-iron)]"
                                                placeholder="e.g. 123456789"
                                            />
                                        </div>
                                    </>
                                )}

                                <div className="pt-4">
                                    <button
                                        type="submit"
                                        disabled={loading}
                                        className="w-full bg-[var(--color-alert)] text-black font-bold uppercase tracking-widest py-4 border-[2px] border-[var(--color-alert)] hover:bg-black hover:text-[var(--color-alert)] transition-none text-sm disabled:opacity-50 disabled:cursor-not-allowed group relative overflow-hidden"
                                    >
                                        <span className="relative z-10">{loading ? "[ PROCESSING... ]" : (view === "login" ? "[ INITIATE_LOGIN ]" : view === "signup" ? "[ ALLOCATE_WORKSPACE ]" : "[ SAVE_AND_CONTINUE ]")}</span>
                                        {/* Hover glitch effect */}
                                        <div className="absolute inset-0 bg-white translate-x-[-100%] group-hover:translate-x-full transition-transform duration-500 opacity-20 pointer-events-none" />
                                    </button>
                                </div>
                            </form>
                        </motion.div>
                    </AnimatePresence>

                    {/* Toggle Button Positioned Outside the Animated Box */}
                    <div className="absolute -bottom-8 left-0 right-0 text-center z-20">
                        <button
                            type="button"
                            onClick={toggleView}
                            className="font-mono text-xs text-[var(--color-silica)] hover:text-white underline decoration-[var(--color-iron)] underline-offset-4 hover:decoration-white transition-colors bg-black px-4 py-2 border border-[var(--color-iron)] uppercase cursor-crosshair"
                        >
                            {view === "login" ? "REQUIRE_NEW_INSTANCE?" : view === "signup" ? "RETURN_TO_LOGIN" : "SKIP_ONBOARDING"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
