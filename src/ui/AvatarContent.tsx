type AvatarContentProps = {
  value?: string;
  fallback: string;
  alt: string;
};

export function isImageAvatar(value?: string) {
  return Boolean(value?.startsWith("data:image/"));
}

export function AvatarContent({ value, fallback, alt }: AvatarContentProps) {
  if (isImageAvatar(value)) {
    return <img className="avatar-image" src={value} alt={alt} />;
  }
  return <span className="avatar-fallback" aria-hidden>{value || fallback}</span>;
}
