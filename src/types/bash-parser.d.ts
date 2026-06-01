declare module 'bash-parser' {
  export interface BashAstNode {
    type?: string;
    text?: string;
    commands?: BashAstNode[];
    name?: BashAstNode;
    prefix?: BashAstNode[];
    suffix?: BashAstNode[];
    expansion?: BashAstNode[];
    commandAST?: BashAstNode;
    command?: string;
    op?: BashAstNode;
    file?: BashAstNode;
    numberIo?: BashAstNode;
    [key: string]: unknown;
  }

  export default function parse(source: string): BashAstNode;
}
