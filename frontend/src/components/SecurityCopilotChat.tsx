"use client";

import { Terminal, Send, X, RefreshCw } from 'lucide-react';
import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';

interface Message {
    role: "user" | "assistant";
    content: string;
}

export default function SecurityCopilotChat() {
    const [isOpen, setIsOpen] = useState(false);
    const [input, setInput] = useState("");
    const [messages, setMessages] = useState<Message[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    const handleSubmit = useCallback(async (e?: React.FormEvent) => {
        e?.preventDefault();
        const trimmed = (input || "").trim();
        if (!trimmed || isLoading) return;

        const userMessage: Message = { role: "user", content: trimmed };
        const updatedMessages = [...messages, userMessage];

        setMessages(updatedMessages);
        setInput("");
        setIsLoading(true);

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messages: updatedMessages }),
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                const errText = errData.error || `HTTP ${res.status}`;
                setMessages(prev => [...prev, {
                    role: "assistant",
                    content: `[SYSTEM ERROR] ${errText}`
                }]);
                return;
            }

            const contentType = res.headers.get("content-type") || "";

            if (contentType.includes("text/plain") || contentType.includes("text/event-stream")) {
                // Streaming response
                const reader = res.body?.getReader();
                const decoder = new TextDecoder();
                let accumulated = "";

                setMessages(prev => [...prev, { role: "assistant", content: "" }]);

                if (reader) {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        accumulated += decoder.decode(value, { stream: true });
                        setMessages(prev => {
                            const updated = [...prev];
                            updated[updated.length - 1] = {
                                role: "assistant",
                                content: accumulated
                            };
                            return updated;
                        });
                    }
                }
            } else {
                // JSON response
                const data = await res.json();
                const responseText = data.content || data.text || data.response || data.output || "[NO RESPONSE]";
                setMessages(prev => [...prev, {
                    role: "assistant",
                    content: responseText
                }]);
            }
        } catch (err: any) {
            setMessages(prev => [...prev, {
                role: "assistant",
                content: `[COMM ERROR] ${err.message || "Failed to reach copilot backend."}`
            }]);
        } finally {
            setIsLoading(false);
        }
    }, [input, messages, isLoading]);

    return (
        <AnimatePresence>
            {!isOpen ? (
                <motion.button
                    key="copilot-toggle"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    onClick={() => setIsOpen(true)}
                    className="fixed bottom-6 right-6 z-50 w-16 h-16 flex items-center justify-center bg-[var(--color-alert)] text-black border-2 border-black hover:bg-black hover:text-[var(--color-alert)] hover:border-[var(--color-alert)] group transition-all duration-300 shadow-[0_0_20px_rgba(255,51,0,0.3)]"
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
                    className="fixed bottom-6 right-6 z-50 w-[400px] h-[600px] max-w-[calc(100vw-3rem)] max-h-[calc(100vh-8rem)] bg-[var(--color-void)] border-2 border-[var(--color-iron)] shadow-2xl flex flex-col font-mono"
                >
                    {/* Header */}
                    <div className="bg-black border-b-2 border-[var(--color-iron)] p-3 flex justify-between items-center cursor-default shrink-0">
                        <div className="flex items-center gap-2 text-[var(--color-alert)] font-mono text-sm font-bold tracking-widest">
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
                                    <p className="text-[10px] mt-2 text-[var(--color-silica)]">MODAL_LLM + SUPERMEMORY_ONLINE</p>
                                </div>
                            )}

                            {messages.map((m, idx) => (
                                <div key={idx} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                                    <div className="text-[9px] text-[var(--color-silica)] mb-1 uppercase">
                                        [{m.role === 'user' ? 'OPERATOR' : 'SEC_COPILOT'}]
                                    </div>
                                    <div className={`max-w-[85%] p-3 text-sm border-l-2 font-sans ${m.role === 'user' ? 'bg-[var(--color-void)] border-[var(--color-data)] text-white' : 'bg-[var(--color-dim)] border-[var(--color-iron)] text-[var(--color-silica)]'}`}>
                                        {m.role === 'assistant' ? (
                                            <div className="copilot-markdown">
                                                <ReactMarkdown>{m.content}</ReactMarkdown>
                                            </div>
                                        ) : (
                                            <div className="whitespace-pre-wrap">{m.content}</div>
                                        )}
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
                                <div className="absolute left-3 top-1/2 -translate-y-1/2 font-bold text-[var(--color-alert)] pointer-events-none">&gt;</div>
                                <input
                                    type="text"
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    placeholder="Enter forensic query..."
                                    className="flex-1 bg-[var(--color-void)] border-2 border-[var(--color-iron)] text-white p-3 pl-8 text-sm focus:outline-none focus:border-[var(--color-alert)] transition-colors placeholder:text-[var(--color-iron)] font-mono"
                                />
                                <button
                                    type="submit"
                                    disabled={isLoading || !(input || "").trim()}
                                    className="px-4 bg-[var(--color-alert)] text-black border-2 border-transparent hover:bg-black hover:text-[var(--color-alert)] hover:border-[var(--color-alert)] font-bold transition-none disabled:opacity-50"
                                >
                                    <Send className="w-5 h-5" />
                                </button>
                            </form>
                        </div>
                    </div>

                    {/* Aesthetic Corner Accents */}
                    <div className="absolute top-0 left-0 w-2 h-2 bg-[var(--color-alert)] -translate-x-[2px] -translate-y-[2px]" />
                    <div className="absolute bottom-0 right-0 w-2 h-2 bg-[var(--color-alert)] translate-x-[2px] translate-y-[2px]" />
                </motion.div>
            )}
        </AnimatePresence>
    );
}
