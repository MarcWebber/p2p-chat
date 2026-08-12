type AvatarContentProps = {
  value?: string;
  fallback: string;
  alt: string;
};

export function AvatarContent({ value, fallback, alt }: AvatarContentProps) {
  if (value?.startsWith("data:image/")) {
    return <img className="avatar-image" src={value} alt={alt} />;
  }
  return <span className="avatar-fallback" aria-hidden>{value || fallback}</span>;
}
