declare module 'better-sqlite3' {
  class Database {
    constructor(filename: string, options?: any);
    exec(sql: string): void;
    prepare(sql: string): Statement;
    pragma(sql: string): any;
    close(): void;
  }

  interface Statement {
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: any[]): any;
    all(...params: any[]): any[];
  }

  namespace Database {
    export type Database = Database;
    export type Statement = Statement;
  }

  export = Database;
}
