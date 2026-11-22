import type { ESLint, Rule } from "eslint";

export declare const OUTSIDE: string[];
export declare function isDirective(text: string): boolean;
export declare function markerVerdict(firstLine: string): string;
export declare const commentsRule: Rule.RuleModule;
export declare const plugin: ESLint.Plugin;
