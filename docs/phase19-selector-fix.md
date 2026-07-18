# Update Sites selector correction

The page now provides a guided update workflow:

1. Select one of the 16 registered GoodOS sites or applications.
2. Select a GitHub repository from the authenticated `preps103` GitHub account.
3. Select the matching PM2 server application target.
4. Confirm the branch.
5. Save, test, or update.

Browser JavaScript is served as `/update-sites.js` instead of being embedded inline. Loading and authentication failures are shown visibly instead of leaving zero counters and an empty table.
