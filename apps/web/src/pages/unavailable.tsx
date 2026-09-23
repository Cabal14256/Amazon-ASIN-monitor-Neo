import { Link } from '@tanstack/react-router';
import { AccountLayout } from './auth/account-layout';

export default function UnavailablePage({
  title = '工作台',
}: {
  title?: string;
}) {
  return (
    <AccountLayout title={title}>
      <section className="rounded-card border border-dashed border-input bg-card p-8 sm:p-12">
        <h2 className="text-lg font-semibold">此页面暂不可用</h2>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          此业务页面正在迁移。监控总览、ASIN 与竞品 ASIN 目录、个人中心现已在
          Neo 工作台开放。
        </p>
        <Link
          to="/home"
          className="mt-5 inline-flex min-h-11 items-center rounded-pill bg-primary px-5 text-sm font-semibold text-primary-foreground"
        >
          返回监控总览
        </Link>
      </section>
    </AccountLayout>
  );
}
