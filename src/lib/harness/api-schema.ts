/**
 * GENERATED. Do not edit by hand: regenerate it.
 *
 * The SpaceRing Harness API's types, from its OpenAPI 3.1 document
 * (https://spacering.net/api/harness/v1/openapi.json):
 *
 *     npx openapi-typescript@7.10.1 openapi.json -o src/lib/harness/api-schema.ts
 *     pnpm prettier --write src/lib/harness/api-schema.ts
 *
 * Generated on 2026-11-15 from the document the website's source builds
 * (`harnessApi.getOpenAPI31Document` over `api/harness/routes.ts`): the live
 * document of that day, plus the `/resolve` route that was not deployed yet.
 * Nothing here is imported at runtime: the file is types only, and
 * `./types.ts` is where the app's own names for them live.
 */

export interface paths {
  "/config": {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /**
     * Limits, kinds, tags and runtimes
     * @description What clients check packages against before installing them, and the lists for filters.
     */
    get: {
      parameters: {
        query?: never
        header?: never
        path?: never
        cookie?: never
      }
      requestBody?: never
      responses: {
        /** @description Client configuration */
        200: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["Config"]
          }
        }
      }
    }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/items": {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /**
     * Browse and search
     * @description Without `q`, public items in order of `sort`. With `q`, the best matches (at most 200), items whose address or exact name is `q` first, listed ones included.
     */
    get: {
      parameters: {
        query?: {
          q?: string
          kind?: "skill" | "mcp" | "prompt" | "assistant" | "connector"
          runtime?: string
          tag?: string
          publisher?: string
          sort?: "popular" | "new" | "updated"
          cursor?: string
          limit?: number
        }
        header?: never
        path?: never
        cookie?: never
      }
      requestBody?: never
      responses: {
        /** @description A page of items */
        200: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["ItemList"]
          }
        }
      }
    }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/items/{publisher}/{name}": {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** An item */
    get: {
      parameters: {
        query?: never
        header?: never
        path: {
          publisher: string
          name: string
        }
        cookie?: never
      }
      requestBody?: never
      responses: {
        /** @description The item, its checks, and how to install its latest version */
        200: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["ItemDetail"]
          }
        }
        /** @description Not found */
        404: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["Error"]
          }
        }
      }
    }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/items/{publisher}/{name}/versions": {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** An item's versions */
    get: {
      parameters: {
        query?: never
        header?: never
        path: {
          publisher: string
          name: string
        }
        cookie?: never
      }
      requestBody?: never
      responses: {
        /** @description Newest first */
        200: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": {
              versions: components["schemas"]["VersionSummary"][]
            }
          }
        }
        /** @description Not found */
        404: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["Error"]
          }
        }
      }
    }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/items/{publisher}/{name}/versions/{revision}": {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** One version, with what it takes to install it */
    get: {
      parameters: {
        query?: never
        header?: never
        path: {
          publisher: string
          name: string
          revision: number
        }
        cookie?: never
      }
      requestBody?: never
      responses: {
        /** @description Files, hashes, packages and permissions */
        200: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["InstallInfo"]
          }
        }
        /** @description Not found */
        404: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["Error"]
          }
        }
      }
    }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/resolve": {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /**
     * How installed items stand now
     * @description For what a client has installed (at most 100, by the items' ids): each item's status, its latest version, and the installed revision as it stands now, with a hash that changes when anything a person agreed to has. Never cached. Anything not out, private or unknown answers `unavailable`, with nothing else.
     */
    post: {
      parameters: {
        query?: never
        header?: never
        path?: never
        cookie?: never
      }
      requestBody: {
        content: {
          "application/json": components["schemas"]["ResolveRequest"]
        }
      }
      responses: {
        /** @description One answer per item, in the order asked */
        200: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["ResolveResponse"]
          }
        }
        /** @description Not a list this takes */
        400: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["Error"]
          }
        }
        /** @description Too long */
        413: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["Error"]
          }
        }
        /** @description Not JSON */
        415: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["Error"]
          }
        }
      }
    }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/items/{publisher}/{name}/readme": {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /**
     * An item's description, as HTML
     * @description Rendered from Markdown when the version was made: no raw HTML, scripts, frames, forms or images; links marked as user content.
     */
    get: {
      parameters: {
        query?: never
        header?: never
        path: {
          publisher: string
          name: string
        }
        cookie?: never
      }
      requestBody?: never
      responses: {
        /** @description An HTML fragment */
        200: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "text/html": string
          }
        }
        /** @description Not found */
        404: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["Error"]
          }
        }
      }
    }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/items/{publisher}/{name}/prompt": {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /**
     * A prompt's text
     * @description Prompts only: the text to use, as plain text (what copying it gives).
     */
    get: {
      parameters: {
        query?: never
        header?: never
        path: {
          publisher: string
          name: string
        }
        cookie?: never
      }
      requestBody?: never
      responses: {
        /** @description The prompt */
        200: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "text/plain": string
          }
        }
        /** @description Not found */
        404: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["Error"]
          }
        }
      }
    }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/publishers/{publisher}": {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** A publisher */
    get: {
      parameters: {
        query?: never
        header?: never
        path: {
          publisher: string
        }
        cookie?: never
      }
      requestBody?: never
      responses: {
        /** @description The publisher */
        200: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["PublisherInfo"]
          }
        }
        /** @description Not found */
        404: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["Error"]
          }
        }
      }
    }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/archives/{file}": {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** A package, as a zip */
    get: {
      parameters: {
        query?: never
        header?: never
        path: {
          file: string
        }
        cookie?: never
      }
      requestBody?: never
      responses: {
        /** @description The zip */
        200: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/zip": string
          }
        }
        /** @description Not found */
        404: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["Error"]
          }
        }
      }
    }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/blobs/{sha256}": {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** One file, by its hash */
    get: {
      parameters: {
        query?: never
        header?: never
        path: {
          sha256: string
        }
        cookie?: never
      }
      requestBody?: never
      responses: {
        /** @description The bytes */
        200: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/octet-stream": string
          }
        }
        /** @description Not found */
        404: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["Error"]
          }
        }
      }
    }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/media/{file}": {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /**
     * A picture, by its hash
     * @description Pictures of items' results, copied here from their sources: WebP, PNG, JPEG or GIF only, told by their bytes.
     */
    get: {
      parameters: {
        query?: never
        header?: never
        path: {
          file: string
        }
        cookie?: never
      }
      requestBody?: never
      responses: {
        /** @description The picture */
        200: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "image/webp": string
          }
        }
        /** @description Not found */
        404: {
          headers: {
            [name: string]: unknown
          }
          content: {
            "application/json": components["schemas"]["Error"]
          }
        }
      }
    }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
}
export type webhooks = Record<string, never>
export interface components {
  schemas: {
    Config: {
      limits: {
        zipBytes: number
        totalBytes: number
        files: number
        fileBytes: number
        depth: number
        pathBytes: number
        compression: {
          minBytes: number
          ratio: number
        }
        textBytes: number
        descriptionChars: number
      }
      kinds: components["schemas"]["Kind"][]
      sorts: ("popular" | "new" | "updated")[]
      runtimes: {
        id: string
        count: number
      }[]
      tags: components["schemas"]["Tag"][]
      /**
       * @description Whether versions get the model review.
       * @enum {string}
       */
      review: "off" | "on"
    }
    /** @enum {string} */
    Kind: "skill" | "mcp" | "prompt" | "assistant" | "connector"
    Tag: {
      id: string
      name: components["schemas"]["Localized"]
      count: number
    }
    /** @description Display text per language. Either may be missing: show the other. */
    Localized: {
      en?: string
      zh?: string
    }
    ItemList: {
      items: components["schemas"]["ItemSummary"][]
      /** @description Pass back as `cursor` for the next page; null on the last. */
      next: string | null
      approxTotal: number | null
    }
    ItemSummary: {
      /** @description Stable id (UUIDv7); survives renames. */
      id: string
      /**
       * @description publisher/name: the address.
       * @example anthropics/pdf
       */
      ref: string
      name: string
      kind: components["schemas"]["Kind"]
      /**
       * @description listed: reachable by address or exact name, not browsed or recommended.
       * @enum {string}
       */
      status: "public" | "listed"
      title: components["schemas"]["Localized"]
      summary: components["schemas"]["Localized"]
      publisher: components["schemas"]["Publisher"]
      tags: string[]
      /** @example python */
      runtime: string
      risk: components["schemas"]["Risk"]
      /** @description A person has reviewed it. */
      reviewed: boolean
      featured: boolean
      /** @enum {string} */
      source: "registry" | "github" | "upload" | "form"
      repoStars: number | null
      stars: number
      installs: number
      latest: {
        revision: number
        version: string | null
        publishedAt: string
      }
      prompt?: components["schemas"]["PromptCard"]
      assistant?: components["schemas"]["AssistantCard"]
    }
    Publisher: {
      /** @example anthropics */
      handle: string
      name: string
      /** @enum {string} */
      kind: "github" | "domain" | "user"
      verified: boolean
      /** @description Imported under this account; its owner has not signed in to claim it yet. */
      unclaimed: boolean
      /**
       * @description The publisher's picture, kept on this site: a GitHub account's avatar or a domain's icon. Null if it has none.
       * @example /api/avatars/0199b5e2-6c4f-7d1a-9f2e-3c8a1b5d7e90/4f1c2a9e8b7d6c5a.png
       */
      avatar: string | null
    }
    /** @enum {string} */
    Risk: "low" | "medium" | "high"
    /** @description Prompts only: what their cards show. */
    PromptCard: {
      /** @description The start of the prompt, on one line. */
      excerpt: string
      /** @description A picture of what it makes, kept on this site; null if there is none. */
      cover: string | null
      /** @description The same, moving (an animated WebP); null if there is none. */
      motion: string | null
      /**
       * @description The model it was written for.
       * @example claude-opus-5-5
       */
      model: string | null
      /** @description Who shared it first (a handle where it was shared, without @). */
      by: string | null
      /** @description How many results made with it its source lists. */
      results: number
      /** @description Its author shared only part of it. */
      partial: boolean
    }
    /** @description Assistants only: what their cards show. */
    AssistantCard: {
      /** @description What it does: its description without examples, cut to what a card shows. */
      role: string
      /**
       * @description As its definition gives it: an alias (sonnet, opus, haiku, fable, inherit) or a model id.
       * @example sonnet
       */
      model: string | null
      /** @description The tools it lists; null when it lists none (not limited). */
      tools: string[] | null
      access: components["schemas"]["Access"]
      /**
       * @description One of Claude Code's eight colours for subagents, the nearest to the one it names; null for none.
       * @example blue
       */
      color: string | null
      /** @description How many skills it has loaded when it starts. */
      skills: number
      /** @description How many MCP servers it names. */
      mcpServers: number
      /** @description The plugin of its repository it comes in. */
      plugin: string | null
      /** @description Other plugins of its repository that carry the same assistant (listed as copies). */
      alsoIn: string[]
    }
    /** @description What an assistant may touch, by its definition's tools. */
    Access: {
      /** @description It may read files (Read, Grep, Glob). */
      read: boolean
      /** @description It may change files (Write, Edit). */
      edit: boolean
      /** @description It may run commands (Bash). */
      run: boolean
      /** @description It may reach the web (WebFetch, WebSearch). */
      web: boolean
      /** @description Its tools are not limited: every tool the agent has, MCP tools included. */
      all: boolean
    }
    ItemDetail: components["schemas"]["ItemSummary"] & {
      license: string | null
      repositoryUrl: string | null
      websiteUrl: string | null
      sourceUrl: string | null
      listedReasons: string[]
      permissions: {
        declared: {
          runsCode?: string[]
          installs?: string[]
          installScripts?: string[]
          network?: string[]
          secrets?: string[]
          paths?: string[]
          /** @description Agent tools it asks for; an assistant that lists none may use all of them, given as ['*']. */
          tools?: string[]
        }
        detected: components["schemas"]["Permissions"]
      }
      checks: {
        findings: components["schemas"]["Finding"][]
        /** @enum {string} */
        review: "off" | "pending" | "done"
        rules: string | null
        checkedAt: string
        /** @description Credentials found (where, never what). */
        secrets: number
        warnings: string[]
        dropped: {
          path: string
          reason: string
        }[]
      }
      /** @description Address of the description, rendered to safe HTML. */
      readme: string | null
      install: components["schemas"]["InstallInfo"]
    }
    Permissions: {
      runsCode: string[]
      installs: string[]
      installScripts: string[]
      network: string[]
      secrets: string[]
      paths: string[]
      /** @description Agent tools it asks for; an assistant that lists none may use all of them, given as ['*']. */
      tools: string[]
    }
    Finding: {
      check: string
      severity: components["schemas"]["Risk"]
      path?: string
      line?: number
      rule?: string
      category?: string
    }
    InstallInfo: {
      item: {
        id: string
        ref: string
        kind: components["schemas"]["Kind"]
        title: components["schemas"]["Localized"]
      }
      version: {
        revision: number
        version: string | null
        publishedAt: string
        /** @enum {string} */
        status: "ok" | "yanked" | "blocked"
      }
      /** @description The whole package as one zip. Null when its license does not let us hand out copies: fetch `files` from `source`. */
      archive: {
        url: string
        sha256: string
        size: number
      } | null
      files: components["schemas"]["FileEntry"][]
      /** @description GitHub owner/repo, commit and folder to fetch the files from when there is no archive. */
      source: {
        repository: string
        commit: string
        path: string
      } | null
      skill?: {
        name: string
        description: string
        allowedTools?: string[]
        license?: string
        compatibility?: string
      }
      /** @description The registry's server.json, as published. */
      server?: {
        name: string
      } & {
        [key: string]: unknown
      }
      prompt?: components["schemas"]["PromptInfo"]
      assistant?: components["schemas"]["AssistantInfo"]
      packages?: components["schemas"]["PinnedPackage"][]
      permissions: components["schemas"]["Permissions"]
      risk: components["schemas"]["Risk"]
      reviewed: boolean
      advisories: components["schemas"]["Advisory"][]
    }
    FileEntry: {
      path: string
      sha256: string
      size: number
      executable: boolean
    }
    /** @description Prompts only. The package is PROMPT.md: this text, with frontmatter. */
    PromptInfo: {
      /** @description The prompt, as it is to be used. */
      text: string
      model: string | null
      /** @description What to add to it, as Claude Code commands give `argument-hint`. */
      argumentHint: string | null
      partial: boolean
      /**
       * @description creators: it belongs to whoever shared it (credit them, see `showcases`); license: the item's license covers it.
       * @enum {string}
       */
      rights: "creators" | "license"
      /** @example en */
      lang: string | null
      /** @description Results made with it, the first first. */
      showcases: components["schemas"]["Showcase"][]
    }
    /** @description A result made with a prompt. */
    Showcase: {
      /** @description Who made and shared it. */
      by: {
        name: string
        url: string | null
      } | null
      /** @description The original post. */
      link: string | null
      /** @description A picture of it, kept on this site. */
      cover: string | null
      /** @description The same, moving. */
      motion: string | null
      category: string | null
      categoryName?: components["schemas"]["Localized"]
      labels: string[]
      /** @description When it was posted, or collected. */
      at: string | null
    }
    /** @description Assistants only. The package is the definition (`file`), a Claude Code subagent as written. */
    AssistantInfo: {
      /** @description As its definition gives it: what it is called once installed (it may differ from the address). */
      name: string
      /**
       * @description The definition, the one file of the package.
       * @example code-reviewer.md
       */
      file: string
      /** @description When to hand it work, without the examples written into it. */
      description: string
      model: string | null
      /** @description null: not limited. */
      tools: string[] | null
      disallowedTools: string[]
      access: components["schemas"]["Access"]
      color: string | null
      /** @description Skills it has loaded when it starts: install them with it. */
      skills: {
        name: string
        /** @description The skill's address in Harness (same publisher), if it has one. */
        ref: string | null
      }[]
      /** @description MCP servers it may use, by the names the user has them under. */
      mcpServers: string[]
      /** @description MCP servers it defines itself with a command to launch. */
      mcpLaunches: string[]
      permissionMode: string | null
      /** @description It brings hooks, which run commands. */
      hooks: boolean
      /** @description Things to say to it. */
      starters: string[]
      examples: components["schemas"]["AssistantExample"][]
      /** @description A line about itself, for people. */
      vibe: string | null
      emoji: string | null
      /** @description The rest of its frontmatter, as written (effort, maxTurns, initialPrompt, ...). */
      settings: {
        [key: string]: unknown
      }
      plugin: string | null
      alsoIn: string[]
    }
    /** @description An example from its definition's description, written for the agent that decides when to hand it work. */
    AssistantExample: {
      context: string | null
      /** @description What the user says. */
      user: string
      /** @description How the main session answers, handing the work over. */
      assistant: string | null
      /** @description Why it is handed over. */
      commentary: string | null
    }
    PinnedPackage: {
      /** @example npm */
      registryType: string
      identifier: string
      version: string | null
      /** @enum {string} */
      verified: "ok" | "missing" | "unchecked" | "pending"
      /** @description npm: the tarball's integrity (sha512-…). */
      integrity?: string
      files?: {
        name: string
        sha256: string
        /** @enum {string} */
        kind: "wheel" | "sdist"
      }[]
      hasInstallScript?: boolean
      fileSha256?: string
    }
    /** @description Security advisories arrive in H3; until then the list is always empty. */
    Advisory: {
      id: string
      severity: components["schemas"]["Risk"]
      /**
       * @description What clients do with installed copies.
       * @enum {string}
       */
      action: "notify" | "disable" | "remove"
      /** @description The versions it applies to; empty for all. */
      revisions: number[]
      summary: components["schemas"]["Localized"]
      publishedAt: string
    }
    Error: {
      /** @example not_found */
      error: string
    }
    VersionSummary: {
      revision: number
      version: string | null
      /** @enum {string} */
      status: "ok" | "yanked" | "blocked"
      risk: components["schemas"]["Risk"]
      publishedAt: string
    }
    ResolveResponse: {
      /** @description One per item asked about, in the order asked. */
      items: components["schemas"]["Resolved"][]
    }
    Resolved:
      | {
          id: string
          /** @enum {string} */
          status: "public" | "listed"
          /**
           * @description Its address now: a rename keeps the id.
           * @example anthropics/pdf
           */
          ref: string
          kind: components["schemas"]["Kind"]
          latest: {
            revision: number
            version: string | null
            publishedAt: string
          }
          advisories: components["schemas"]["Advisory"][]
          installed: components["schemas"]["VersionState"]
        }
      | {
          id: string
          /**
           * @description retired: stopped by its author or its source; removed: taken down.
           * @enum {string}
           */
          status: "retired" | "removed"
          installed: {
            revision: number
            /** @enum {string} */
            status: "ok" | "yanked" | "blocked"
          } | null
        }
      | {
          id: string
          /**
           * @description Not out, private, or no such item: which of these is not told.
           * @enum {string}
           */
          status: "unavailable"
        }
    /** @description The revision asked about, as it stands now; null if the item has no such revision. */
    VersionState: {
      revision: number
      /** @enum {string} */
      status: "ok" | "yanked" | "blocked"
      risk: components["schemas"]["Risk"]
      reviewed: boolean
      permissions: {
        declared: {
          runsCode?: string[]
          installs?: string[]
          installScripts?: string[]
          network?: string[]
          secrets?: string[]
          paths?: string[]
          /** @description Agent tools it asks for; an assistant that lists none may use all of them, given as ['*']. */
          tools?: string[]
        }
        detected: components["schemas"]["Permissions"]
      }
      checks: {
        /** @description How many findings of each severity. */
        findings: {
          low: number
          medium: number
          high: number
        }
        secrets: number
        /** @enum {string} */
        review: "off" | "pending" | "done"
      }
      packages: {
        registryType: string
        identifier: string
        version: string | null
        /** @enum {string} */
        verified: "ok" | "missing" | "unchecked" | "pending"
        hasInstallScript: boolean
      }[]
      /** @description SHA-256 of the fields above as JSON with sorted keys. Equal on two answers means nothing a person agreed to has changed in between. */
      stateSha256: string
    } | null
    ResolveRequest: {
      installed: {
        /** @description The item's id, as `item.id` gave it when it was installed. */
        id: string
        /** @description The revision that was installed. */
        revision: number
      }[]
    }
    PublisherInfo: components["schemas"]["Publisher"] & {
      githubLogin: string | null
      domain: string | null
      items: number
    }
  }
  responses: never
  parameters: never
  requestBodies: never
  headers: never
  pathItems: never
}
export type $defs = Record<string, never>
export type operations = Record<string, never>
