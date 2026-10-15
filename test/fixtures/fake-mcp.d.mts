import type { Transport } from "@modelcontextprotocol/client";

export declare const TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }>;
export declare function answer(msg: Record<string, unknown>, opts?: { tools?: unknown[]; onCrash?: () => void }): Record<string, unknown> | null;
export declare function serve(transport: Transport, opts?: { tools?: unknown[]; onCrash?: () => void }): Promise<Transport>;
