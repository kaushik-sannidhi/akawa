"use client";

import { useState, useEffect, useRef } from "react";
import { MessageSquare, X, Send, Plus, Terminal, RefreshCw, ChevronLeft, Trash2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { ref, push, set, onValue, update, remove } from "firebase/database";
import { getDatabase } from "firebase/database";
import app from "@/lib/firebase";
import { motion, AnimatePresence } from "framer-motion";

interface ChatMessage {
    role: "user" | "assistant";
    content: string;
    timestamp: number;
}

interface ChatSession {
    id: string;
    title: string;
    updatedAt: number;
    messages?: Record<string, ChatMessage>;
}

export default function ChatBot() {
    const { user } = useAuth();
    const [isOpen, setIsOpen] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [chats, setChats] = useState<ChatSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [view, setView] = useState<"list" | "chat">("list");
    const [unreadCount, setUnreadCount] = useState(0);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const isOpenRef = useRef(isOpen);

    useEffect(() => {
        isOpenRef.current = isOpen;
        if (isOpen && view === "chat") {
            setUnreadCount(0);
        }
    }, [isOpen, view]);

    const db = getDatabase(app);

    // Scroll to bottom when messages change
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, view, isOpen, isExpanded]);

    // Fetch chat history from Firebase
    useEffect(() => {
        if (!user) return;

        const chatsRef = ref(db, `users/${user.uid}/chats`);
        const unsubscribe = onValue(chatsRef, (snapshot) => {
            if (snapshot.exists()) {
                const data = snapshot.val();
                const formattedChats = Object.keys(data).map(key => ({
                    id: key,
                    ...data[key].meta
                })).sort((a, b) => b.updatedAt - a.updatedAt);
                setChats(formattedChats);
            } else {
                setChats([]);
            }
        });

        return () => unsubscribe();
    }, [user, db]);

    // Fetch active chat messages
    useEffect(() => {
        if (!user || !activeChatId) return;

        const messagesRef = ref(db, `users/${user.uid}/chats/${activeChatId}/messages`);
        const unsubscribe = onValue(messagesRef, (snapshot) => {
            if (snapshot.exists()) {
                const data = snapshot.val();
                // Ensure messages are sorted by timestamp
                const formattedMessages = Object.keys(data).map(key => data[key]).sort((a, b) => a.timestamp - b.timestamp);

                setMessages(prev => {
                    if (!isOpenRef.current && formattedMessages.length > prev.length) {
                        const newMsgs = formattedMessages.slice(prev.length);
                        const assistantMsgs = newMsgs.filter(m => m.role === "assistant").length;
                        setUnreadCount(c => c + assistantMsgs);
                    }
                    return formattedMessages;
                });
            } else {
                setMessages([]);
            }
        });

        return () => unsubscribe();
    }, [user, activeChatId, db]);

    const handleCreateChat = async () => {
        if (!user) return;
        const chatsRef = ref(db, `users/${user.uid}/chats`);
        const newChatRef = push(chatsRef);

        const initialTitle = "New Analysis " + new Date().toLocaleTimeString();

        await set(ref(db, `users/${user.uid}/chats/${newChatRef.key}/meta`), {
            title: initialTitle,
            updatedAt: Date.now()
        });

        setActiveChatId(newChatRef.key);
        setView("chat");
    };

    const handleSelectChat = (chatId: string) => {
        setActiveChatId(chatId);
        setView("chat");
    };

    const handleDeleteChat = async (e: React.MouseEvent, chatId: string) => {
        e.stopPropagation();
        if (!user) return;
        await remove(ref(db, `users/${user.uid}/chats/${chatId}`));
        if (activeChatId === chatId) {
            setActiveChatId(null);
            setView("list");
        }
    };

    const handleSendMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || !user || !activeChatId) return;

        const userMsgContent = input.trim();
        setInput(""); // clear immediately for UX
        setIsLoading(true);

        const messagesRef = ref(db, `users/${user.uid}/chats/${activeChatId}/messages`);

        // 1. Save user message to Firebase
        const userMsg: ChatMessage = {
            role: "user",
            content: userMsgContent,
            timestamp: Date.now()
        };
        await push(messagesRef, userMsg);

        // Update chat meta timestamp
        await update(ref(db, `users/${user.uid}/chats/${activeChatId}/meta`), {
            updatedAt: Date.now()
        });

        // 2. Prepare payload for Gemini (needs full history + current message)
        const conversationContext = [...messages, userMsg].map(m => ({
            role: m.role,
            content: m.content
        }));

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messages: conversationContext })
            });

            if (!res.ok) {
                throw new Error("Failed to communicate with AI core.");
            }

            const data = await res.json();

            // 3. Save AI response to Firebase
            const aiMsg: ChatMessage = {
                role: "assistant",
                content: data.reply || data.error || "UNKNOWN_ERROR",
                timestamp: Date.now()
            };
            await push(messagesRef, aiMsg);

            // Auto-title generation if first message
            if (messages.length === 0) {
                const titleSnippet = userMsgContent.length > 20 ? userMsgContent.substring(0, 20) + "..." : userMsgContent;
                await update(ref(db, `users/${user.uid}/chats/${activeChatId}/meta`), {
                    title: `[Q] ${titleSnippet}`,
                    updatedAt: Date.now()
                });
            }

        } catch (error) {
            console.error("Chat API Error:", error);
            // Push an error message
            await push(messagesRef, {
                role: "assistant",
                content: "SYSTEM_ERROR: Connection to Generative Core severed.",
                timestamp: Date.now()
            });
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <AnimatePresence>
            {!isOpen ? (
                <motion.button
                    key="chat-toggle"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 300, damping: 25 }}
                    onClick={() => setIsOpen(true)}
                    className="fixed bottom-6 right-6 z-50 w-16 h-16 flex items-center justify-center bg-[var(--color-alert)] text-black border-2 border-black hover:bg-black hover:text-[var(--color-alert)] hover:border-[var(--color-alert)] group transition-all duration-300 shadow-[0_0_20px_rgba(255,51,0,0.3)]"
                    title="Initialize AI Analyst"
                >
                    <Terminal className="w-8 h-8 group-hover:scale-110 transition-transform" />
                    {unreadCount > 0 && (
                        <div className="absolute -top-3 -right-3 bg-white text-black text-xs font-black w-7 h-7 flex items-center justify-center border-2 border-black shadow-lg animate-pulse">
                            {unreadCount}
                        </div>
                    )}
                </motion.button>
            ) : (
                <motion.div
                    key="chat-window"
                    initial={{ y: 50, opacity: 0, scale: 0.95, originX: 1, originY: 1 }}
                    animate={{ y: 0, opacity: 1, scale: 1 }}
                    exit={{ y: 50, opacity: 0, scale: 0.95 }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    className={`fixed z-50 bg-[var(--color-void)] border-2 border-[var(--color-iron)] shadow-2xl flex flex-col ${isExpanded ? 'inset-4 sm:inset-10 transition-all duration-300' : 'bottom-6 right-6 w-[350px] h-[500px] max-w-[calc(100vw-3rem)] max-h-[calc(100vh-8rem)]'}`}
                >

                    {/* Header */}
                    <div className="bg-black border-b-2 border-[var(--color-iron)] p-3 flex justify-between items-center cursor-default shrink-0">
                        <div className="flex items-center gap-2 text-[var(--color-alert)] font-mono text-sm font-bold tracking-widest">
                            <Terminal className="w-4 h-4" />
                            [ AI ASSISTANT ]
                        </div>
                        <div className="flex items-center gap-2">
                            <button onClick={() => setIsExpanded(!isExpanded)} className="text-[var(--color-silica)] hover:text-white p-1" title="Toggle Expansion">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
                            </button>
                            <button onClick={() => setIsOpen(false)} className="text-[var(--color-silica)] hover:text-[var(--color-alert)] p-1" title="Terminate Session">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                    </div>

                    {/* Main Content Area */}
                    <div className="flex-1 overflow-hidden relative font-mono flex flex-col">

                        {/* LIST VIEW */}
                        {view === "list" && (
                            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                                <button
                                    onClick={handleCreateChat}
                                    className="w-full flex items-center justify-center gap-2 p-4 bg-[var(--color-data)] text-black border-2 border-transparent hover:bg-black hover:text-[var(--color-data)] hover:border-[var(--color-data)] font-bold mb-6 transition-none uppercase text-xs"
                                >
                                    <Plus className="w-4 h-4" /> START NEW CHAT
                                </button>

                                <div className="text-[10px] text-[var(--color-silica)] border-b border-[var(--color-iron)] mb-2 pb-1">PREVIOUS CHATS:</div>

                                {chats.length === 0 ? (
                                    <div className="text-center text-xs text-[var(--color-iron)] p-8">NO PREVIOUS CHATS</div>
                                ) : (
                                    <div className="space-y-2">
                                        {chats.map(chat => (
                                            <div key={chat.id} className="relative group">
                                                <button
                                                    onClick={() => handleSelectChat(chat.id)}
                                                    className="w-full text-left p-3 bg-[var(--color-dim)] border border-[var(--color-iron)] hover:border-[var(--color-data)] hover:text-[var(--color-data)] flex flex-col gap-1 transition-none"
                                                >
                                                    <span className="text-xs font-bold truncate group-hover:text-[var(--color-data)] text-white pr-8">{chat.title}</span>
                                                    <span className="text-[9px] text-[var(--color-silica)]">LAST_UPDATE: {new Date(chat.updatedAt).toLocaleString()}</span>
                                                </button>
                                                <button
                                                    onClick={(e) => handleDeleteChat(e, chat.id)}
                                                    className="absolute top-1/2 right-3 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-[var(--color-silica)] hover:text-[var(--color-alert)] transition-none"
                                                    title="DELETE CHAT"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* CHAT VIEW */}
                        {view === "chat" && (
                            <div className="flex-1 flex flex-col h-full">
                                {/* Chat Header */}
                                <div className="p-2 border-b border-[var(--color-iron)] bg-[var(--color-dim)] flex items-center justify-between shrink-0">
                                    <button onClick={() => setView("list")} className="flex items-center gap-1 text-[10px] text-[var(--color-silica)] hover:text-white px-2 py-1 bg-black border border-[var(--color-iron)]">
                                        <ChevronLeft className="w-3 h-3" /> BACK TO CHATS
                                    </button>
                                    <div className="text-[10px] text-[var(--color-alert)]">AI ONLINE</div>
                                </div>

                                {/* Messages Area */}
                                <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-[#050505] relative">
                                    {messages.length === 0 && (
                                        <div className="absolute inset-0 flex flex-col items-center justify-center opacity-30 pointer-events-none select-none p-8 font-mono text-center">
                                            <Terminal className="w-16 h-16 mb-4 text-[var(--color-data)]" />
                                            <p className="text-sm font-bold">STATE: AWAITING_INPUT</p>
                                            <p className="text-[10px] mt-2 text-[var(--color-silica)]">GEMINI_PRO_MODEL_INITIALIZED</p>
                                        </div>
                                    )}

                                    {messages.map((msg, idx) => (
                                        <div key={idx} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                                            <div className="text-[9px] text-[var(--color-silica)] mb-1 uppercase">
                                                [{msg.role === 'user' ? 'OPERATOR' : 'SYS_AI'}] - {new Date(msg.timestamp).toLocaleTimeString()}
                                            </div>
                                            <div className={`max-w-[85%] p-3 text-sm border-l-2 font-sans ${msg.role === 'user' ? 'bg-[var(--color-void)] border-[var(--color-data)] text-white ml-8' : 'bg-[var(--color-dim)] border-[var(--color-alert)] text-[var(--color-silica)] mr-8'}`}>
                                                <div className="whitespace-pre-wrap">{msg.content}</div>
                                            </div>
                                        </div>
                                    ))}
                                    {isLoading && (
                                        <div className="flex flex-col items-start">
                                            <div className="text-[9px] text-[var(--color-silica)] mb-1 uppercase">[SYS_AI] - COMPUTING...</div>
                                            <div className="max-w-[85%] p-3 text-sm border-l-2 bg-[var(--color-dim)] border-[var(--color-alert)] text-[var(--color-alert)] mr-8 flex items-center gap-2">
                                                <RefreshCw className="w-4 h-4 animate-spin" /> SYNTHESIZING_RESPONSE
                                            </div>
                                        </div>
                                    )}
                                    <div ref={messagesEndRef} />
                                </div>

                                {/* Input Area */}
                                <div className="p-4 border-t-2 border-[var(--color-iron)] bg-black shrink-0">
                                    <form onSubmit={handleSendMessage} className="flex gap-2 relative">
                                        <div className="absolute left-3 top-1/2 -translate-y-1/2 font-bold text-[var(--color-alert)] pointer-events-none">&gt;</div>
                                        <input
                                            type="text"
                                            value={input}
                                            onChange={(e) => setInput(e.target.value)}
                                            placeholder="Type a message..."
                                            className="flex-1 bg-[var(--color-void)] border-2 border-[var(--color-iron)] text-white p-3 pl-8 text-sm focus:outline-none focus:border-[var(--color-data)] transition-colors placeholder:text-[var(--color-iron)] font-mono disabled:opacity-50"
                                            disabled={isLoading}
                                            autoFocus
                                        />
                                        <button
                                            type="submit"
                                            disabled={isLoading || !input.trim()}
                                            className="px-4 bg-[var(--color-data)] text-black border-2 border-transparent hover:bg-black hover:text-[var(--color-data)] hover:border-[var(--color-data)] font-bold transition-none disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            <Send className="w-5 h-5" />
                                        </button>
                                    </form>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Aesthetic Border Elements */}
                    <div className="absolute top-0 left-0 w-2 h-2 bg-[var(--color-alert)] -translate-x-[2px] -translate-y-[2px]" />
                    <div className="absolute bottom-0 right-0 w-2 h-2 bg-[var(--color-alert)] translate-x-[2px] translate-y-[2px]" />
                </motion.div>
            )}
        </AnimatePresence>
    );
}
