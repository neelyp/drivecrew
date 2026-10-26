// Firebase configuration for crews.
//
// These values are NOT secrets - a Firebase web config is shipped to every
// browser that loads the app, by design. What protects the data is
// firestore.rules, which must be published in the Firebase console.
//
// To reset this file back to placeholders, copy firebase-config.example.js
// over it; the app then runs in local-only mode and the Crew tab says so.

export const firebaseConfig = {
  apiKey: 'AIzaSyCqDsOdJ4kGOx4JDpnZWvdOU0C3tes7YWs',
  authDomain: 'drivecrew-b301d.firebaseapp.com',
  projectId: 'drivecrew-b301d',
  storageBucket: 'drivecrew-b301d.firebasestorage.app',
  messagingSenderId: '315076972066',
  appId: '1:315076972066:web:290e0560ed2ea1f974047b',
};
