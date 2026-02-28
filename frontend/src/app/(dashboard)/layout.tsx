"use client";

import { useAuth } from "@/context/AuthContext";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { auth } from "@/lib/firebase";
import { signOut } from "firebase/auth";
import { TelemetryProvider } from "@/context/TelemetryContext";
import { SettingsProvider } from "@/context/SettingsContext";
import ChatBot from "@/components/ChatBot";
import SecurityCopilotChat from "@/components/SecurityCopilotChat";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
    const { user, loading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [mobileNavOpen, setMobileNavOpen] = useState(false);

    useEffect(() => {
        if (!loading && !user) {
            router.push("/login");
        }
    }, [user, loading, router]);

    if (loading || !user) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[var(--color-void)] font-mono text-[var(--color-alert)] text-sm tracking-widest font-bold">
                [ ESTABLISHING_SECURE_CONNECTION... ]
            </div>
        );
    }

    const handleLogout = async () => {
        await signOut(auth);
        router.push("/");
    };

    return (
        <div className="flex h-[100dvh] bg-[var(--color-void)] font-sans uppercase tracking-tight text-[var(--color-data)] overflow-hidden selection:bg-[var(--color-alert)] selection:text-black">

            {/* Mobile sidebar backdrop */}
            {sidebarOpen && (
                <div
                    className="fixed inset-0 bg-black/60 z-30 lg:hidden"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            {/* Mobile top menu backdrop */}
            {mobileNavOpen && (
                <div
                    className="fixed inset-0 bg-black/50 z-30 lg:hidden"
                    onClick={() => setMobileNavOpen(false)}
                />
            )}

            {/* Sidebar - hidden on mobile, overlay when toggled */}
            <aside className={`
                fixed inset-y-0 left-0 z-40 w-64 bg-black border-r-[2px] border-[var(--color-iron)] flex flex-col flex-shrink-0
                transform transition-transform duration-200 ease-out
                ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
                lg:static lg:translate-x-0 lg:z-20
            `}>
                <div className="absolute inset-0 bg-[linear-gradient(rgba(51,51,51,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(51,51,51,0.5)_1px,transparent_1px)] bg-[size:32px_32px] opacity-10 pointer-events-none" />

                <div className="px-6 py-4 border-b-[2px] border-[var(--color-iron)] flex items-center gap-2 relative z-10">
                    <div className="w-3 h-3 bg-[var(--color-alert)] animate-[pulse_2s_ease-in-out_infinite]" />
                    <span className="font-mono font-bold text-xl text-[var(--color-data)]">AKAWA_OS</span>
                </div>

                <div className="px-6 py-2 border-b-[2px] border-[var(--color-iron)] font-mono text-[10px] text-[var(--color-silica)] bg-[var(--color-dim)] relative z-10 flex flex-col">
                    <span>DIR: ROOT/OPERATIONS</span>
                    <span className="text-[var(--color-alert)] mt-1">ACCESS_LEVEL: ADMIN</span>
                </div>

                <nav className="flex-1 flex flex-col pt-4 relative z-10 font-mono text-xs font-bold tracking-widest">
                    <Link
                        href="/dashboard"
                        onClick={() => setSidebarOpen(false)}
                        className={`px-6 py-4 flex items-center justify-between border-y border-transparent transition-none ${pathname === '/dashboard' ? 'bg-[var(--color-data)] text-black border-[var(--color-data)]' : 'text-[var(--color-silica)] hover:text-white hover:bg-[var(--color-dim)] hover:border-[var(--color-iron)] group'}`}
                    >
                        [ OVERVIEW ]
                        {pathname === '/dashboard' && <span className="animate-pulse">_</span>}
                    </Link>
                    <Link
                        href="/dashboard/upload"
                        onClick={() => setSidebarOpen(false)}
                        className={`px-6 py-4 flex items-center justify-between border-y border-transparent transition-none ${pathname.includes('/upload') ? 'bg-[var(--color-data)] text-black border-[var(--color-data)]' : 'text-[var(--color-silica)] hover:text-white hover:bg-[var(--color-dim)] hover:border-[var(--color-iron)]'}`}
                    >
                        [ UPLOAD VIDEO ]
                        {pathname.includes('/upload') && <span className="animate-pulse">_</span>}
                    </Link>
                    <Link
                        href="/dashboard/live"
                        onClick={() => setSidebarOpen(false)}
                        className={`px-6 py-4 flex items-center justify-between border-y border-transparent transition-none ${pathname.includes('/live') ? 'bg-[var(--color-alert)] text-black border-[var(--color-alert)]' : 'text-[var(--color-alert)] hover:bg-black hover:border-[var(--color-alert)] opacity-70 hover:opacity-100'}`}
                    >
                        [ LIVE CAMERAS ]
                        {pathname.includes('/live') && <span className="animate-pulse">_</span>}
                    </Link>
                    <Link
                        href="/dashboard/settings"
                        onClick={() => setSidebarOpen(false)}
                        className={`px-6 py-4 flex items-center justify-between border-y border-transparent transition-none ${pathname.includes('/settings') ? 'bg-[var(--color-data)] text-black border-[var(--color-data)]' : 'text-[var(--color-silica)] hover:text-white hover:bg-[var(--color-dim)] hover:border-[var(--color-iron)]'}`}
                    >
                        [ SETTINGS ]
                        {pathname.includes('/settings') && <span className="animate-pulse">_</span>}
                    </Link>
                </nav>

                <div className="border-t-[2px] border-[var(--color-iron)] relative z-10 bg-black">
                    <button
                        onClick={handleLogout}
                        className="w-full text-left px-6 py-4 font-mono text-xs font-bold tracking-widest text-[var(--color-silica)] hover:bg-[var(--color-alert)] hover:text-black transition-none uppercase"
                    >
                        [ LOG OUT ]
                    </button>
                </div>
            </aside>

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col min-w-0 bg-[var(--color-dim)] relative">

                {/* Header Top Bar */}
                <header className="h-14 border-b-[2px] border-[var(--color-iron)] flex items-center justify-between px-4 lg:px-6 bg-black z-10 flex-shrink-0">
                    <div className="flex items-center gap-3">
                        {/* Hamburger for mobile */}
                        <button
                            onClick={() => setSidebarOpen(!sidebarOpen)}
                            className="lg:hidden flex flex-col gap-1 p-2 -ml-2"
                            aria-label="Toggle menu"
                        >
                            <span className="block w-5 h-0.5 bg-[var(--color-data)]" />
                            <span className="block w-5 h-0.5 bg-[var(--color-data)]" />
                            <span className="block w-5 h-0.5 bg-[var(--color-data)]" />
                        </button>
                        <h2 className="font-mono font-bold text-xs sm:text-sm text-[var(--color-data)]">
                            {pathname === '/dashboard' ? 'DASHBOARD OVERVIEW' : pathname.includes('live') ? 'LIVE CAMERAS' : pathname.includes('upload') ? 'UPLOAD VIDEO' : 'SETTINGS'}
                        </h2>
                    </div>
                    <div className="relative flex items-center gap-2 sm:gap-4 bg-[var(--color-iron)] pl-2 pr-1 py-1">
                        <button
                            onClick={() => setMobileNavOpen((prev) => !prev)}
                            className="lg:hidden border border-white text-[8px] font-mono font-bold px-2 py-1 text-white"
                            aria-label="Open dashboard menu"
                        >
                            MENU
                        </button>
                        <span className="font-mono text-[8px] sm:text-[10px] text-white hidden sm:inline max-w-[32vw] truncate">OP_ID: {user.email}</span>
                        <div className="w-4 h-4 bg-black border border-white flex items-center justify-center font-mono text-[8px] text-white font-bold flex-shrink-0">
                            {user.email?.charAt(0).toUpperCase() ?? "?"}
                        </div>

                        {mobileNavOpen && (
                            <div className="absolute top-[calc(100%+8px)] right-0 z-40 lg:hidden w-56 border-[2px] border-[var(--color-iron)] bg-black">
                                <div className="px-3 py-2 text-[9px] font-mono text-[var(--color-silica)] border-b border-[var(--color-iron)]">
                                    DASHBOARD_NAV
                                </div>
                                <nav className="flex flex-col text-[10px] font-mono font-bold tracking-widest">
                                    <Link
                                        href="/dashboard"
                                        onClick={() => setMobileNavOpen(false)}
                                        className={`px-3 py-3 border-b border-[var(--color-iron)] ${pathname === '/dashboard' ? 'bg-[var(--color-data)] text-black' : 'text-[var(--color-data)]'}`}
                                    >
                                        [ OVERVIEW ]
                                    </Link>
                                    <Link
                                        href="/dashboard/upload"
                                        onClick={() => setMobileNavOpen(false)}
                                        className={`px-3 py-3 border-b border-[var(--color-iron)] ${pathname.includes('/upload') ? 'bg-[var(--color-data)] text-black' : 'text-[var(--color-data)]'}`}
                                    >
                                        [ UPLOAD VIDEO ]
                                    </Link>
                                    <Link
                                        href="/dashboard/live"
                                        onClick={() => setMobileNavOpen(false)}
                                        className={`px-3 py-3 border-b border-[var(--color-iron)] ${pathname.includes('/live') ? 'bg-[var(--color-alert)] text-black' : 'text-[var(--color-alert)]'}`}
                                    >
                                        [ LIVE CAMERAS ]
                                    </Link>
                                    <Link
                                        href="/dashboard/settings"
                                        onClick={() => setMobileNavOpen(false)}
                                        className={`px-3 py-3 ${pathname.includes('/settings') ? 'bg-[var(--color-data)] text-black' : 'text-[var(--color-data)]'}`}
                                    >
                                        [ SETTINGS ]
                                    </Link>
                                </nav>
                            </div>
                        )}
                    </div>
                </header>

                {/* Sub Header / Breadcrumb Bar — hidden on small mobile */}
                <div className="hidden sm:flex h-8 border-b-[2px] border-[var(--color-iron)] bg-[var(--color-void)] items-center px-4 lg:px-6 font-mono text-[10px] text-[var(--color-silica)] flex-shrink-0">
                    WORKSPACE {"//"} {pathname.replace('/', '').toUpperCase() || 'DASHBOARD'} {"//"} {new Date().toISOString()} {"//"} SECURE_SOCKET_ESTABLISHED
                </div>

                {/* Scrollable Main Content */}
                <main className="flex-1 overflow-y-auto p-3 sm:p-4 lg:p-6 relative z-10 font-sans custom-scrollbar">
                    <SettingsProvider>
                        <TelemetryProvider>
                            {children}
                        </TelemetryProvider>
                    </SettingsProvider>
                </main>
            </div>

            {/* Global AI Assistant */}
            <ChatBot />

            {/* Security Copilot - Specific tool for Supermemory/CCTV logs */}
            <SecurityCopilotChat />
        </div>
    );
}
