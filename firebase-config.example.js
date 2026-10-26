// Firebase configuration for crews. The app runs fully without this: leave the
// placeholders alone and DriveCrew stays in local-only mode (tracking, history,
// records, share cards all work; the Crew tab explains it is not set up).
//
// To switch crews on, follow "Setting up crews" in README.md and paste the
// config object Firebase gives you over the placeholders below.
//
// These values are NOT secrets - they ship to every browser that loads the app.
// What protects your data is firestore.rules, so deploy those too.

export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};
