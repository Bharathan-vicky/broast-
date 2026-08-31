import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import CryptoTerminal from './CryptoTerminal';
import NiftyTerminal from './NiftyTerminal';
import MobileTerminal from './MobileTerminal';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<MobileTerminal />} />
        <Route path="/mobile" element={<MobileTerminal />} />
        <Route path="/nifty" element={<NiftyTerminal />} />
        <Route path="/crypto" element={<CryptoTerminal />} />
        <Route path="/desktop" element={<CryptoTerminal />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}

export default App;
