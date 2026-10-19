import { GeneratedByUserBadgeView, type GeneratedByUserBadgeViewProps } from '@mahoshojo/ui-web/arena-report';
import { useAuth } from '@/lib/useAuth';
import Badge from '@/components/badge/Badge';

type GeneratedByUserBadgeProps = Omit<GeneratedByUserBadgeViewProps, 'username' | 'badges'> & { fallbackUsername?: string };

export function GeneratedByUserBadge({ fallbackUsername, ...props }: GeneratedByUserBadgeProps) {
  const { user, userBadges, isAuthenticated, loading } = useAuth();
  const authenticated = !loading && isAuthenticated && user;
  const username = authenticated ? (user.username || '').trim() || `用户${user.id}` : fallbackUsername;
  const equippedBadges = authenticated ? (Array.isArray(userBadges) ? userBadges : [])
    .filter(badge => badge.isEquipped).sort((a, b) => a.displayOrder - b.displayOrder) : [];
  return <GeneratedByUserBadgeView {...props} username={username} badges={equippedBadges.length ? equippedBadges.map(userBadge => (
    <Badge key={userBadge.id} badge={userBadge.badge} size="sm" className="opacity-95" />
  )) : null} />;
}
