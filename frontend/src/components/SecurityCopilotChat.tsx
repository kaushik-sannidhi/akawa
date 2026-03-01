"use client";

import { useChat } from '@ai-sdk/react';
import { Terminal, Send, X, RefreshCw } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// AI SDK 3.0+

export default function SecurityCopilotChat() {
    const [isOpen, setIsOpen] = useState(false);
    const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat() as any;
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    return (
        <AnimatePresence>
            {!isOpen ? (
                <motion.button
                    key="copilot-toggle"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    onClick={() => setIsOpen(true)}
                    className="fixed bottom-6 right-24 z-50 w-16 h-16 flex items-center justify-center bg-[var(--color-data)] text-black border-2 border-black hover:bg-black hover:text-[var(--color-data)] hover:border-[var(--color-data)] group transition-all duration-300 shadow-[0_0_20px_rgba(0,255,102,0.3)]"
                    title="Initialize Security Copilot"
                >
                    <Terminal className="w-8 h-8 group-hover:scale-110 transition-transform" />
                </motion.button>
            ) : (
                <motion.div
                    key="copilot-window"
                    initial={{ y: 50, opacity: 0, scale: 0.95, originX: 1, originY: 1 }}
                    animate={{ y: 0, opacity: 1, scale: 1 }}
                    exit={{ y: 50, opacity: 0, scale: 0.95 }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    className="fixed bottom-6 right-24 z-50 w-[400px] h-[600px] max-w-[calc(100vw-3rem)] max-h-[calc(100vh-8rem)] bg-[var(--color-void)] border-2 border-[var(--color-iron)] shadow-2xl flex flex-col font-mono"
                >
                    {/* Header */}
                    <div className="bg-black border-b-2 border-[var(--color-iron)] p-3 flex justify-between items-center cursor-default shrink-0">
                        <div className="flex items-center gap-2 text-[var(--color-data)] font-mono text-sm font-bold tracking-widest">
                            <Terminal className="w-4 h-4" />
                            [ SECURITY_COPILOT ]
                        </div>
                        <button onClick={() => setIsOpen(false)} className="text-[var(--color-silica)] hover:text-[var(--color-alert)] p-1">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Chat Area */}
                    <div className="flex-1 overflow-hidden relative flex flex-col">
                        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-[#050505]">
                            {messages.length === 0 && (
                                <div className="absolute inset-0 flex flex-col items-center justify-center opacity-30 pointer-events-none select-none p-8 text-center">
                                    <Terminal className="w-16 h-16 mb-4 text-[var(--color-data)]" />
                                    <p className="text-sm font-bold">STATE: ANALYTICAL_CORE_READY</p>
                                    <p className="text-[10px] mt-2 text-[var(--color-silica)]">COPILOT_GPT4o_ONLINE</p>
                                </div>
                            )}

                            {messages.map((m: any, idx: number) => (
                                <div key={idx} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                                    <div className="text-[9px] text-[var(--color-silica)] mb-1 uppercase">
                                        [{m.role === 'user' ? 'OPERATOR' : 'SEC_COPILOT'}]
                                    </div>
                                    <div className={`max-w-[85%] p-3 text-sm border-l-2 font-sans ${m.role === 'user' ? 'bg-[var(--color-void)] border-[var(--color-data)] text-white' : 'bg-[var(--color-dim)] border-[var(--color-iron)] text-[var(--color-silica)]'}`}>
                                        <div className="whitespace-pre-wrap">{m.content}</div>
                                    </div>
                                </div>
                            ))}

                            {isLoading && (
                                <div className="flex flex-col items-start">
                                    <div className="text-[9px] text-[var(--color-silica)] mb-1 uppercase">[SEC_COPILOT] - ANALYZING...</div>
                                    <div className="max-w-[85%] p-3 text-sm border-l-2 bg-[var(--color-dim)] border-[var(--color-data)] text-[var(--color-data)] flex items-center gap-2">
                                        <RefreshCw className="w-4 h-4 animate-spin" /> SCANNING_MEMORY
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Input Area */}
                        <div className="p-4 border-t-2 border-[var(--color-iron)] bg-black shrink-0">
                            <form onSubmit={handleSubmit} className="flex gap-2 relative">
                                <div className="absolute left-3 top-1/2 -translate-y-1/2 font-bold text-[var(--color-data)] pointer-events-none">&gt;</div>
                                <input
                                    type="text"
                                    value={input}
                                    onChange={handleInputChange}
                                    placeholder="Enter forensic query..."
                                    className="flex-1 bg-[var(--color-void)] border-2 border-[var(--color-iron)] text-white p-3 pl-8 text-sm focus:outline-none focus:border-[var(--color-data)] transition-colors placeholder:text-[var(--color-iron)] font-mono"
                                />
                                <button
                                    type="submit"
                                    disabled={isLoading || !input.trim()}
                                    className="px-4 bg-[var(--color-data)] text-black border-2 border-transparent hover:bg-black hover:text-[var(--color-data)] hover:border-[var(--color-data)] font-bold transition-none disabled:opacity-50"
                                >
                                    <Send className="w-5 h-5" />
                                </button>
                            </form>
                        </div>
                    </div>

                    {/* Aesthetic Corner Accents */}
                    <div className="absolute top-0 left-0 w-2 h-2 bg-[var(--color-data)] -translate-x-[2px] -translate-y-[2px]" />
                    <div className="absolute bottom-0 right-0 w-2 h-2 bg-[var(--color-data)] translate-x-[2px] translate-y-[2px]" />
                </motion.div>
            )}
        </AnimatePresence>
    );
}
