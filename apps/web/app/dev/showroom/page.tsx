'use client';

import { notFound } from 'next/navigation';

import { ShowroomView } from '@mahoshojo/ui-web/showroom';

/**
 * 视觉样板间（SPEC-visual-baseline-v1 VIS-SHOW-001）：开发期审查入口，
 * 生产构建一律 404——该页只验证视觉基线，不承载产品功能。
 */
export default function DevShowroomPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ShowroomView />;
}
