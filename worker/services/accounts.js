// Application user accounts. Deliberately provider-agnostic on the storage
// side (a user is just a bag of `identities`) even though Google is the
// only provider actually wired up right now - the architecture brief asks
// for this to extend to other providers or native cryptographic identities
// later without a data-model rewrite.
import { verifyGoogleIdToken } from "../auth/google.js";

/** @typedef {{ provider: string, subject: string, [k: string]: unknown }} Identity */

export class AccountsService {
  #state;
  #googleClientId;
  #logger;

  constructor({ state, googleClientId, logger }) {
    this.#state = state;
    this.#googleClientId = googleClientId;
    this.#logger = logger;
  }

  async #findOrCreateByIdentity(identity) {
    const existing = await this.#state.users.findByIdentity(identity.provider, identity.subject);
    if (existing) {
      const updated = { ...existing, identities: existing.identities.map((i) => (i.provider === identity.provider && i.subject === identity.subject ? { ...i, ...identity } : i)), updatedAt: Date.now() };
      await this.#state.users.put(updated);
      return updated;
    }
    const user = {
      userId: crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      identities: [identity],
      displayName: identity.name ?? identity.email ?? "New user",
    };
    await this.#state.users.put(user);
    this.#logger.info("accounts", `created new user ${user.userId} via ${identity.provider}`);
    return user;
  }

  /**
   * RPC handler: verifies a Google ID token worker-side (never trusts the
   * viewer's own decode of it) and upserts an application user keyed by the
   * stable `sub` claim, not email. If the caller's Nostr pubkey isn't
   * already linked to this user, links it too - that pubkey is the one the
   * RPC transport already authenticated (it's who encrypted/signed this
   * very request), so it's safe to trust here without a further check.
   */
  async linkGoogleAccount({ idToken }, { fromPubkey }) {
    if (!this.#googleClientId) throw new Error("Google sign-in is not configured on this worker (no client id set).");
    if (typeof idToken !== "string" || !idToken) throw new Error("idToken is required.");

    const claims = await verifyGoogleIdToken(idToken, this.#googleClientId);
    if (!claims.emailVerified) throw new Error("Google account email is not verified.");

    let user = await this.#findOrCreateByIdentity({ provider: "google", subject: claims.sub, email: claims.email, name: claims.name });
    if (!user.identities.some((i) => i.provider === "nostr" && i.subject === fromPubkey)) {
      user = { ...user, identities: [...user.identities, { provider: "nostr", subject: fromPubkey }], updatedAt: Date.now() };
      await this.#state.users.put(user);
    }
    this.#logger.info("accounts", `linked Google account for user ${user.userId} (nostr ${fromPubkey.slice(0, 8)}…)`);
    return { userId: user.userId, displayName: user.displayName };
  }

  /** RPC handler: resolves the caller's application user purely from the pubkey that authenticated this request. */
  async getCurrentUser(_params, { fromPubkey }) {
    const user = await this.#state.users.findByIdentity("nostr", fromPubkey);
    if (!user) return null;
    return { userId: user.userId, displayName: user.displayName };
  }

  registerRpc(rpc) {
    rpc.handle("linkGoogleAccount", (params, ctx) => this.linkGoogleAccount(params, ctx));
    rpc.handle("getCurrentUser", (params, ctx) => this.getCurrentUser(params, ctx));
  }
}
