export class WordsSearch {
  SetKeywords(keywords: string[]): void;
  ContainsAny(text: string): boolean;
  FindAll(text: string): {
    Keyword: string;
    Success: boolean;
    End: number;
    Start: number;
    Index: number;
  }[];
}
