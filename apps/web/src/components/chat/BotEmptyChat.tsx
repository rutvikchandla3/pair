export function BotEmptyChat({ name }: { name: string }) {
  return (
    <div className="flex max-w-[520px] flex-col items-center gap-2 text-center">
      <h2 className="font-semibold text-foreground text-xl">What should {name} take on?</h2>
      <p className="text-muted-foreground text-sm">
        Give it work in any of your projects. It starts sessions, answers their questions the way
        you would, and asks you only what it can't decide. Everything it does shows up here.
      </p>
    </div>
  );
}
