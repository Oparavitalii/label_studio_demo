import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import AppShell from './labels/components/AppShell.jsx';
import Creator from './pages/Creator';
import PrintTarget from './pages/Print';
import Production from './pages/Production';
import Templates from './pages/Templates';

import './styles/index.css';

// AppShell is a LAYOUT route: it renders the nav once and drops each page
// into its <Outlet/>, so navigating between Creator / Production /
// Templates never remounts the chrome.
//
// /labels is kept as a legacy alias because scripts/verify-print.mjs still
// drives the printer through that URL.
function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path='/' element={<Navigate to='/creator' replace />} />
          <Route path='/creator' element={<Creator />} />
          <Route path='/production' element={<Production />} />
          <Route path='/templates' element={<Templates />} />
          <Route path='/labels' element={<Navigate to='/creator' replace />} />
        </Route>
        {/* OUTSIDE the layout route on purpose. /print/:jobId is the render
            target the server opens in headless Chrome to make a PDF, so no
            nav markup may exist on it at all - not hidden by print.css,
            never rendered. */}
        <Route path='/print/:jobId' element={<PrintTarget />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
