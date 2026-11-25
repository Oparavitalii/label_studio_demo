// The application shell: one nav across the top, the routed page below it.
//
// It lives in src/labels/components/ on purpose. scripts/verify-style.mjs
// assertion 6 requires every lbl-* class to be referenced from the code it
// scans, and its CODE_DIRS is hardcoded to src/labels/components and
// src/labels/model - a shell parked anywhere else would make its own
// classes look dead to the check.
//
// It also owns the stylesheet imports that src/pages/Labels/index.jsx used
// to hold, so every route - not just the editor - gets the tokens.
import { NavLink, Outlet } from 'react-router-dom';

import BrandMark from './BrandMark.jsx';
// tokens first: every other sheet reads its --lbl-* values.
// shell.css LAST: it re-heights .lbl-root at equal specificity, which only
// resolves the way it must if it is the later rule in source order.
import '../styles/tokens.css';
import '../styles/brand.css';
import '../styles/editor.css';
import '../styles/print.css';
import '../styles/shell.css';

export default function AppShell() {
  return (
    <div className='lbl-shell'>
      <nav className='lbl-nav'>
        {/* The lockup: mark over a line naming what this instance is. The
            brandbook builds it the same way - wordmark, then a short line
            beneath in the eyebrow treatment (uppercase, weighted, widely
            tracked). The brand's own line there is its
            slogan; this app says what it does instead. */}
        <div className='lbl-nav__lockup'>
          <BrandMark className='lbl-nav__brand' />
          <p className='lbl-nav__tagline'>Printing system</p>
        </div>
        {/* NavLink sets aria-current="page" on the active link by itself, so
            the active style hangs off that attribute - the state is in the
            accessibility tree first and the stylesheet second. */}
        <ul className='lbl-nav__list'>
          <li>
            <NavLink to='/creator' className='lbl-nav__link'>
              Creator
            </NavLink>
          </li>
          <li>
            <NavLink to='/production' className='lbl-nav__link'>
              Production
            </NavLink>
          </li>
          <li>
            <NavLink to='/templates' className='lbl-nav__link'>
              Templates
            </NavLink>
          </li>
        </ul>
      </nav>
      <div className='lbl-outlet'>
        <Outlet />
      </div>
    </div>
  );
}
