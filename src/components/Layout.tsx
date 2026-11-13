import { useState, type ReactNode } from 'react';
import { asset, Link, navigate, useLocation } from '../lib/router';
import { useAuth } from '../lib/auth';
import { useCart } from '../lib/cart';

export function Layout({ children }: { children: ReactNode }) {
  const { session, isStaff, signOut } = useAuth();
  const { lines } = useCart();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const cur = (p: string) => (pathname === p ? 'page' : undefined);

  return (
    <>
      <a href="#main" className="sr-only">Skip to content</a>
      <div className="topbar">
        MOQ from <b>25 units</b> · Custom logo branding · Ready-stock gadgets, bags &amp; eco gifts
      </div>
      <header className="site">
        <div className="wrap nav">
          <button className="menu-t" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>☰</button>
          <Link to="/" className="brand" aria-label="Swagarage home">
            <img src={asset('mono.png')} alt="" width={42} height={42} />
            <span className="wm"><b>SWAGARAGE</b><i>Build Your Swag!</i></span>
          </Link>
          <nav className={`links ${open ? 'open' : ''}`} onClick={() => setOpen(false)}>
            <Link to="/shop" aria-current={cur('/shop')}>Shop all</Link>
            <Link to="/shop?collection=employee-welcome-kits">Welcome kits</Link>
            <Link to="/assistant" aria-current={cur('/assistant')}>Gift Assistant</Link>
            {isStaff && <Link to="/admin">Admin</Link>}
          </nav>
          <div className="nav-right">
            {session ? (
              <>
                <Link to="/account" className="pillbtn"><span aria-hidden>👤</span><span className="lbl">Account</span></Link>
                <button
                  className="pillbtn lbl"
                  onClick={async () => {
                    await signOut();
                    navigate('/');
                  }}
                >
                  Sign out
                </button>
              </>
            ) : (
              <Link to="/login" className="pillbtn">Sign in</Link>
            )}
            <Link to="/quote" className="pillbtn" aria-label={`Quote, ${lines.length} products`}>
              <span aria-hidden>🛒</span><span className="lbl">Quote</span><span className="count">{lines.length}</span>
            </Link>
          </div>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="site">
        <div className="wrap">
          <div className="g">
            <div>
              <img src={asset('logo.png')} alt="Swagarage" style={{ height: 84, background: '#fff', borderRadius: 12, padding: 8, marginBottom: 12 }} />
              <p>Corporate gifts and branded merchandise for teams, clients and events.</p>
            </div>
            <div>
              <h2>Shop</h2>
              <Link to="/shop">All products</Link>
              <Link to="/shop?category=bags-backpacks">Bags &amp; Backpacks</Link>
              <Link to="/shop?category=gadgets-tech">Gadgets &amp; Tech</Link>
              <Link to="/shop?category=apparel">Apparel</Link>
            </div>
            <div>
              <h2>Occasions</h2>
              <Link to="/shop?collection=employee-welcome-kits">Welcome kits</Link>
              <Link to="/shop?collection=diwali-festive">Diwali &amp; festive</Link>
              <Link to="/shop?collection=premium-client-gifts">Client gifts</Link>
              <Link to="/shop?collection=eco-friendly-gifts">Eco-friendly</Link>
            </div>
            <div>
              <h2>Ordering</h2>
              <p>MOQ from 25 units<br />GST applicable on all products<br />Packaging &amp; shipping charged extra<br />50% advance, 50% on delivery</p>
            </div>
          </div>
          <div className="bot">© {new Date().getFullYear()} Swagarage · Build Your Swag!</div>
        </div>
      </footer>
    </>
  );
}
