import { Button } from "@/components/ui/button";

/**
 * Home and Access before their pages land (#258): each opens today's things from the new tab.
 * Home becomes #259; Access becomes #265.
 */
export function HomePlaceholder({ homeName, onOpenHome, onOpenHunt }: { homeName: string | null; onOpenHome: () => void; onOpenHunt: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-[1040px] flex-col gap-4 px-6 py-10">
      <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Home</h1>
      <p className="text-[13px] text-muted-foreground">
        What changed since a mark lands with the next release. Until then, Home opens the hunt.
      </p>
      <div className="flex gap-2">
        {homeName ? (
          <Button type="button" size="sm" onClick={onOpenHome}>
            Open {homeName}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant={homeName ? "outline" : "default"} onClick={onOpenHunt}>
          Open the hunt
        </Button>
      </div>
    </main>
  );
}

export function AccessPlaceholder({ onTokens, onShares, onLinks }: { onTokens: () => void; onShares: () => void; onLinks: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-[1040px] flex-col gap-4 px-6 py-10">
      <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Access</h1>
      <p className="text-[13px] text-muted-foreground">
        Every way in or out of this instance, other than the operator password. One list lands with the next release; until then each kind opens where it lives today.
      </p>
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onTokens}>
          Ingest tokens
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onLinks}>
          Links
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onShares}>
          Shares
        </Button>
      </div>
    </main>
  );
}
