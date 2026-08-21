export function LoadingButtonLabel({ children }: { children: string }) {
  return (
    <span className="loading-button-label">
      <span className="btn-spinner" aria-hidden="true" />
      {children}
    </span>
  );
}
