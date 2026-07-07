export type CommentAuthor = 'user' | 'codex';

export interface Comment {
  id?: string;
  parentId?: string | null;
  author?: CommentAuthor;
  body: string;
  createdAt: string;
  endLine?: number;
  viewed?: boolean;
  pending?: boolean;
  error?: string;
}

export type LineComments = Record<number, Comment[]>;
export type Comments = Record<string, LineComments>;

export type SectionViewed = Record<string, boolean>;
export type ViewedMap = Record<string, SectionViewed>;

export interface Section {
  id: string;
  title: string;
  body: string;
  startLine: number;
  endLine: number;
}
