/**
 * Static CLI help kept separate from the command implementation graph.
 *
 * The installed entrypoint imports only this module and the static release
 * identity for a valid help request, so help remains available even when an
 * optional provider runtime is broken.
 */
export const wrenchUsage = `Usage:
  wrench --version                                  Print the exact Wrench release version
  wrench init [directory] [--json]                    Initialize a Markdown vault
  wrench inspect <url> [capture-options]              Inspect capture without persistence
  wrench pdf <file-or-url> [pdf-options]               Capture a PDF into the vault
  wrench refresh|check|graph [vault-options]           Maintain or inspect the vault graph
  wrench backlinks|links <note> [vault-options]        Navigate explicit note relationships
  wrench list [query-options]                          Query notes and metadata
  wrench index [semantic-options]                      Build the local semantic index
  wrench search <query> [semantic-options]             Search the local vault
  wrench url-metadata backfill [metadata-options]      Backfill saved URL metadata
  wrench context <repository-path> [context-options]   Resolve scoped agent context
  wrench agents identity|check|audit [...]             Inspect repository agent guides
  wrench adapters [--json]                             List public capture adapters

  wrench <url> [slug] [clip-options] [--auth <id>]       Capture a durable clip
  wrench clip <url> [slug] [clip-options] [--auth <id>]  Capture a durable clip
  wrench read <url> [clip-options] [--auth <id>]         Read without persistence
  wrench archive <url> [media-options]            Create a verified complete media archive
  wrench media [archive|audio|video|transcript] <url> [media-options]
  wrench audio|video|transcript <url> [media-options]
  wrench verify <archive-item-directory> [--json] Verify every archived media artifact
  wrench transcriber setup --engine whisper-cpp --model <file> [media-options]
  wrench doctor [--json]                         Check capture, media, auth, and action dependencies
  wrench capabilities [adapter] [--json]         List installed semantic capabilities
  wrench imessage transport install --binary <absolute-reviewed-imsg-file> [--json]
                                                 Install only the current reviewed iMessage transport bytes
  wrench plugin list [--json]                    List trusted source and installed portable plugins
  wrench plugin show <id> [--json]               Inspect one source or portable plugin
  wrench plugin scaffold --site <id> --display-name <name> --origin <https-origin>
                           --operation <semantic.action> --risk <R1|R2|R3>
                           --evidence <internal-api-evidence.json> --candidate <index>
                           --output <empty-directory> [--json]
  wrench plugin init <id> --display-name <name> --surface <id> --origin <https-origin>
                     --operation <semantic.action>
                     [--transport provider-api|web-session-api|linked-device]
                     [--scope-set <comma-list>...] [--coverage <comma-list>]
                     --output <empty-directory> [--json]
  wrench plugin check <directory> [--json]        Check a source or portable plugin
  wrench plugin test <directory> --trust-code [--json]
                                                Run secret-free portable fixtures
  wrench plugin pack <directory> --output <empty.wrenchplugin-directory> [--json]
  wrench plugin install <package-directory> --trust-code
                    [--expected-current <bundle-sha256>] [--json]
  wrench plugin doctor [--json]
  wrench plugin disable <id> [--expected-current <bundle-sha256>] [--json]
  wrench plugin remove <id> [--expected-current <bundle-sha256>] --yes [--json]
  wrench platforms [surface-id] [--json]         Inspect reviewed policy, not installed adapters
  wrench thread split <surface-id> --text <text|@file|-> [--json]
  wrench thread publish <surface-id> --adapter <id> --text <text|@file|-> --auth <id>
                        [--preview] [--headed] [--json]
  wrench operator doctor [--json]                Compatibility alias for 'wrench doctor'

  wrench auth list [--json]
  wrench auth login <id> --client-file <desktop-client.json>
                         [--no-open] [--force] [--json]
  wrench auth bind <id> --site <provider-surface-id> [--force] [--json]
  wrench auth add <id> --cookie-source <browser> [--cookie-profile <name>]
                       [--subject <provider-viewer-or-account-id>] [--force]
  wrench auth add <id> --cookies-file <path>
                       [--subject <provider-viewer-or-account-id>] [--force]
  wrench auth add <id> --browser-profile <name|path> --trust-profile-egress
                       [--browser-executable <absolute-browser-binary>]
                       [--cookie-source <browser> [--cookie-profile <name>]]
                       [--subject <provider-viewer-or-account-id>] [--force]
  wrench auth add <id> --oauth-provider <provider-surface-id> --token-file <path>
                       --scopes <comma-list> [--subject <provider-viewer-or-account-id>] [--force]
  wrench auth add <id> --linked-device <provider-surface-id> [--device-store <private-directory>]
                       [--subject <provider-account-id>] [--force]
  wrench auth pair <id> [--phone <international-number>]
  wrench auth sync <id> --once [--json]       Explicitly connect and refresh the local projection
  wrench auth remove <id> --yes

  wrench apple-photos export-contact-evidence
                [--library <normalized-absolute-.photoslibrary>] [--json]
                # private cluster evidence; returned JSON has no images, crops, or templates

  wrench beeper export-message-like-me --auth <id> --output <new-absolute-directory>
                [--limit-chats <n>] [--limit-messages <n>]
                [--max-participants <n>] [--json]
  wrench beeper export-contact-interactions --auth <id>
                [--limit-chats <n>] [--limit-messages <n>]
                [--max-participants <n>] [--json]
                # body-free receipt/output envelope on stdout; progress on stderr

  wrench messaging routes --input <-|@absolute-private-file>
                          --private-output <absolute-mode-0600-file> [--json]
  wrench messaging resolve --input <-|@absolute-private-file>
                           --private-output <absolute-mode-0600-file> [--json]
  wrench messaging context --input <-|@absolute-private-file>
                           --private-output <absolute-mode-0600-file> [--json]
  wrench messaging preview --input <-|@absolute-private-file>
                           --private-output <absolute-mode-0600-file> [--json]
  wrench messaging reconcile <run-id> [--json]
                # capability refs and bodies never appear in argv or stdout

  wrench adapter init <id> (--origin <https-origin> | --platform <surface-id>)
                             --output <directory> [--force]
  wrench adapter sync-bundled [--json]                 Install or safely upgrade reviewed bundled manifests
  wrench adapter scaffold [plugin-scaffold-options]  Compatibility alias for 'wrench plugin scaffold'
  wrench adapter validate <manifest> [--json]
  wrench adapter install <manifest> [--force | --upgrade-from <prior-bundled-manifest>...]
  wrench adapter remove <id> --yes

  wrench derive start <id> <url> [--auth <id>] [--content none|text] [--domains <list>]
                       [--cookie-origin <exact-https-origin>...] [--fixture <media>...]
                       [--allow-remote-actions] [--headed] [--json]
  wrench derive list [--json]
  wrench derive browser <derivation-id> -- <semantic agent-browser command>
                       # bounded textbox reset: cleartext @snapshot-textbox-ref
                       # bounded upload: upload @ref|@single-file-input|@single-image-input|@single-video-input fixture:<n>...
                       # chooser upload: choose-upload @upload-control-ref fixture:<n>...
                       # terminal upload: upload-and-seal @ref|@single-file-input|@single-image-input|@single-video-input fixture:<n>...
  wrench derive review <derivation-id> [--review-origin <exact-https-origin>]
                       [--offset <n> --limit <1-100>] [--json]
  wrench derive review <derivation-id> --entry <zero-based>
                       [--review-origin <exact-https-origin>]
                       [--fixtures - | --field-names -] [--json]
  wrench derive finish <derivation-id> --output <directory> [--review-origin <exact-https-origin>]
                       [--platform <surface-id>] [--force] [--json]
  wrench derive analyze <har> --adapter <id> --origin <origin> --output <directory> [--platform <surface-id>]
  wrench derive discard <derivation-id> --yes

  wrench invoke <adapter> <operation> [--input <json|@file|->] [--auth <id>]
                [--preview | --cache-only | --projection-identity-only]
                [--duplicate-risk-of <run-id>]
                [--headed] [--json]
  wrench omni read --input <json|@file|->
                [--cache-only | --identity-only | --from-exact-cache]
                [--headed] [--json]
  wrench <adapter> <operation> [invoke-options]  Shorthand for 'wrench invoke'
  wrench confirm <plan-digest> [--headed] [--private-output <absolute-path> --receipt-binding-output <absolute-path>] [--json]
  wrench plans list [--json]
  wrench plans cancel <plan-digest> --yes
  wrench runs list [--json]
  wrench runs show <run-id> [--private-output <absolute-path> --receipt-binding-output <absolute-path>] [--json]
  wrench runs reconcile <run-id> [--input <json|@file|->] [--json]  Reconcile from transport-specific external evidence

Local browser admission:
  Wrench runs at most two locally owned browsers across processes sharing one
  state home for fresh/profile page capture. Polling consumes the capture
  timeout and has a 30-second budget; an in-flight bounded state helper may
  settle later, but no browser launches after deadline revalidation. Initialize
  a new state home serially with 'wrench runs list --json'.
  Explicit CDP and browser-live attachments skip this gate. Same-boot stale
  claims stay occupied; use 'wrench doctor --json' for the state-home path.
  Managed provider/bootstrap and derivation sessions remain outside this cap.

Risk policy:
  R1 authenticated reads execute directly. R2/R3 writes create an exact, five-minute
  preview plan; run 'wrench confirm <digest>' to execute it once. R4 is blocked.
  Signed-in site actions use code-owned first-party API or linked-device protocol
  contracts; browser action recipes are rejected across protected site families.
  Wrench never exposes arbitrary eval, request, selector, cookie, storage, or raw
  file-transfer capabilities.

Read projections:
  Successful subject-bound R1 results publish encrypted exact-query snapshots.
  Repeat the invocation with --cache-only to return that snapshot without a browser
  or provider roundtrip. --projection-identity-only returns only opaque auth/query
  identity and the validated input hash without decoding the snapshot. A normal
  invocation explicitly revalidates it. Unbound reads are never cached.
  Bind the auth locator to its verified account subject before private snapshots can
  be served.

Omni views:
  Supported provider inbox reads materialize into encrypted Conversation, Message,
  and Notification entities. 'omni read --cache-only' returns the merged local view
  without provider work. A normal omni read explicitly revalidates each declared
  source; --from-exact-cache rebuilds derivatives from exact snapshots only.
`;
