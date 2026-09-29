import { navigate, useRoute } from './lib/navigation';
import { Landing } from './pages/Landing';
import { RoomPage } from './pages/RoomPage';

export function App() {
  const route = useRoute();
  if (route.name === 'room') return <RoomPage key={route.roomId} roomId={route.roomId} />;
  if (route.name === 'landing') return <Landing />;
  return (
    <main className="landing">
      <div className="card stack">
        <h1>Page not found</h1>
        <button className="btn btn--primary" onClick={() => navigate('/')}>
          Back to start
        </button>
      </div>
    </main>
  );
}
