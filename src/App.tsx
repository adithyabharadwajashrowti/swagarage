import { lazy, Suspense } from 'react';
import { RequireAuth } from './components/Guards';
import { Spinner } from './components/ui';
import { Layout } from './components/Layout';
import { AuthProvider } from './lib/auth';
import { CartProvider } from './lib/cart';
import { CatalogueProvider } from './lib/catalogue';
import { Link, RouterProvider, Routes, type Route } from './lib/router';
import { ToastProvider } from './lib/toast';
import { ForgotPasswordPage, LoginPage, ResetPasswordPage, SignupPage } from './pages/AuthPages';
import { AssistantPage, Home } from './pages/Home';
import { ProductPage } from './pages/ProductPage';
import { QuotePage } from './pages/QuotePage';
import { Shop } from './pages/Shop';

// Admin and account code is split out: visitors never download it.
const AdminLayout = lazy(() => import('./admin/AdminLayout').then((m) => ({ default: m.AdminLayout })));
const AdminDashboard = lazy(() => import('./admin/Quotes').then((m) => ({ default: m.AdminDashboard })));
const AdminQuotes = lazy(() => import('./admin/Quotes').then((m) => ({ default: m.AdminQuotes })));
const AdminQuoteDetail = lazy(() => import('./admin/Quotes').then((m) => ({ default: m.AdminQuoteDetail })));
const AdminProducts = lazy(() => import('./admin/Products').then((m) => ({ default: m.AdminProducts })));
const AdminProductEdit = lazy(() => import('./admin/Products').then((m) => ({ default: m.AdminProductEdit })));
const AdminImport = lazy(() => import('./admin/Other').then((m) => ({ default: m.AdminImport })));
const AdminUsers = lazy(() => import('./admin/Other').then((m) => ({ default: m.AdminUsers })));
const AdminAudit = lazy(() => import('./admin/Other').then((m) => ({ default: m.AdminAudit })));
const AccountPage = lazy(() => import('./pages/Account').then((m) => ({ default: m.AccountPage })));
const AccountQuotePage = lazy(() => import('./pages/Account').then((m) => ({ default: m.AccountQuotePage })));

const routes: Route[] = [
  { path: '/', render: () => <Home /> },
  { path: '/shop', render: () => <Shop /> },
  { path: '/product/:slug', render: ({ slug }) => <ProductPage key={slug} slug={slug!} /> },
  { path: '/assistant', render: () => <AssistantPage /> },
  { path: '/quote', render: () => <QuotePage /> },
  { path: '/login', render: () => <LoginPage /> },
  { path: '/signup', render: () => <SignupPage /> },
  { path: '/forgot-password', render: () => <ForgotPasswordPage /> },
  { path: '/reset-password', render: () => <ResetPasswordPage /> },
  { path: '/account', render: () => <RequireAuth><AccountPage /></RequireAuth> },
  { path: '/account/quotes/:ref', render: ({ ref }) => <RequireAuth><AccountQuotePage key={ref} quoteRef={ref!} /></RequireAuth> },
  { path: '/admin', render: () => <AdminLayout><AdminDashboard /></AdminLayout> },
  { path: '/admin/quotes', render: () => <AdminLayout><AdminQuotes /></AdminLayout> },
  { path: '/admin/quotes/:id', render: ({ id }) => <AdminLayout><AdminQuoteDetail key={id} id={id!} /></AdminLayout> },
  { path: '/admin/products', render: () => <AdminLayout><AdminProducts /></AdminLayout> },
  { path: '/admin/products/:id', render: ({ id }) => <AdminLayout><AdminProductEdit key={id} id={id!} /></AdminLayout> },
  { path: '/admin/import', render: () => <AdminLayout><AdminImport /></AdminLayout> },
  { path: '/admin/users', render: () => <AdminLayout adminOnly><AdminUsers /></AdminLayout> },
  { path: '/admin/audit', render: () => <AdminLayout adminOnly><AdminAudit /></AdminLayout> },
];

function NotFound() {
  return (
    <div className="wrap page">
      <h1>Page not found</h1>
      <p className="sub">The page you're looking for doesn't exist.</p>
      <Link to="/" className="btn sec">Go home</Link>
    </div>
  );
}

export function App() {
  return (
    <RouterProvider>
      <ToastProvider>
        <AuthProvider>
          <CatalogueProvider>
            <CartProvider>
              <Layout>
                <Suspense fallback={<Spinner />}>
                  <Routes routes={routes} fallback={<NotFound />} />
                </Suspense>
              </Layout>
            </CartProvider>
          </CatalogueProvider>
        </AuthProvider>
      </ToastProvider>
    </RouterProvider>
  );
}
